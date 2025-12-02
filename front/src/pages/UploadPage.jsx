// src/pages/UploadPage.jsx
import React, { useEffect, useRef, useState } from 'react'
import Layout from '../components/Layout'
import { apiFetch, extractRecordsWithGemini } from '../lib/api.js'

/**
 * ============================
 *  DB 구조 기준 설계 메모
 * ============================
 *
 * - ingest_uploads
 *    id           : uuid  → 업로드 ID
 *    file_name    : text
 *    status       : text  → queued / processing / success / failed
 *    progress     : int   → 0~100
 *    student_id   : uuid? (대표 학생)
 *    created_at   : timestamptz → 업로드 시각
 *
 * - log_entries
 *    id              : uuid
 *    log_date        : date
 *    student_id      : uuid
 *    emotion_tag     : text (대표 감정)
 *    activity_tags   : text[] (활동 유형 태그)
 *    log_content     : text (텍스트 전체 or 요약)
 *    related_metrics : jsonb[] (점수, 소요시간, 능력 등 복합 구조)
 *
 * - emotion_keywords
 *    id        : uuid
 *    name      : text (감정 키워드)
 *
 * 이 UploadPage에서는 /uploads/:id/log 로 아래처럼 저장합니다:
 *
 * POST /uploads/:id/log
 * {
 *   upload_id: <ingest_uploads.id>,
 *   file_name: <ingest_uploads.file_name>,
 *   raw_text: "<공통 편집 텍스트>",
 *   log_entries: [
 *     {
 *       student_id: "<학생 uuid>",
 *       student_name: "학생 이름(프론트 표시용)",
 *       log_date: "YYYY-MM-DD",
 *       emotion_tag: "감정 요약 한 줄",
 *       emotion_tags: ["즐거움", "긴장" ...],
 *       activity_tags: ["수확", "파종" ...],
 *       log_content: "<공통 텍스트 또는 학생별 텍스트>",
 *       related_metrics: {
 *         duration_minutes: 90,
 *         activity_name: "...",
 *         activity_type: "...",
 *         note: "...",
 *         level: "...",
 *         ability: ["집중력", "소근육"],
 *         score: 85,
 *         score_explanation: "...",
 *         emotionTags: [...],
 *         emotionSummary: "..."
 *       }
 *     },
 *     ...
 *   ]
 * }
 */

// -------------------- 업로드 목록 전역 캐시 --------------------
let uploadsCache = null

const detailDrafts = {}

// -------------------- 헬퍼 / 상수 --------------------

const STEP_DEFS = [
  { key: 'extract', label: '텍스트 추출' },
  { key: 'ai', label: 'AI 자동 분석' },
  { key: 'save', label: '데이터베이스 저장' },
]

// 단계별 진행률로 전체 진행률 계산
function computeOverallFromSteps(steps, fallbackProgress) {
  const keys = STEP_DEFS.map(s => s.key)
  if (!keys.length) {
    return typeof fallbackProgress === 'number' ? fallbackProgress : 0
  }
  let sum = 0
  keys.forEach(k => {
    const v = steps && typeof steps[k] === 'number' ? steps[k] : 0
    sum += v
  })
  return Math.round(sum / keys.length)
}

// 업로드 목록 응답 포맷 정규화
function normalizeUploads(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.items)) return data.items
  if (data && Array.isArray(data.uploads)) return data.uploads
  return []
}

// 감정 태그 정규화
function normalizeEmotionTags(rawValue) {
  if (!rawValue) return []
  if (Array.isArray(rawValue)) {
    return rawValue
      .map(v => String(v || '').trim())
      .filter(Boolean)
  }
  if (typeof rawValue === 'string') {
    return rawValue
      .split(/[,\s/]+/)
      .map(v => v.trim())
      .filter(Boolean)
  }
  return []
}

// 감정 태그 직렬화(저장용)
function serializeEmotionTags(rawValue) {
  if (!rawValue) return []
  if (Array.isArray(rawValue)) {
    return rawValue
      .map(v => {
        if (!v) return ''
        if (typeof v === 'string') return v
        if (typeof v === 'object') {
          return v.label || v.name || ''
        }
        return String(v)
      })
      .map(v => v.trim())
      .filter(Boolean)
  }
  if (typeof rawValue === 'string') {
    return rawValue
      .split(/[,\s/]+/)
      .map(v => v.trim())
      .filter(Boolean)
  }
  return []
}

// 원본 텍스트에서 날짜(YYYY-MM-DD) 후보 추출
function parseDatesFromText(text) {
  if (!text || typeof text !== 'string') return []
  const result = new Set()

  // 예: 2025-11-21, 2025.11.21, 2025/11/21, 2025년 11월 21일
  const re =
    /(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})[일]?/g

  let m
  while ((m = re.exec(text)) !== null) {
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])

    if (!year || month < 1 || month > 12 || day < 1 || day > 31) continue
    const mm = String(month).padStart(2, '0')
    const dd = String(day).padStart(2, '0')
    result.add(`${year}-${mm}-${dd}`)
  }

  return Array.from(result).sort()
}

// 분석 필드 정규화
function normalizeAnalysis(raw) {
  const a = raw.analysis || {}
  const legacyEmotion =
    raw.emotion_tag || a.emotion || a.emotionSummary

  const emotionTagsRaw =
    a.emotionTags ||
    a.emotion_tags ||
    raw.emotion_tags ||
    a.emotion_keywords ||
    raw.emotion_keywords ||
    null

  return {
    students: a.students || raw.students || [],
    date: a.date || raw.date || raw.log_date || null,
    activityName:
      a.activityName ||
      a.activity_name ||
      raw.activityName ||
      raw.activity_name ||
      raw.title ||
      '',
    durationMinutes:
      a.durationMinutes ||
      a.duration_minutes ||
      raw.durationMinutes ||
      raw.duration_minutes ||
      null,
    activityType:
      a.activityType ||
      a.activity_type ||
      raw.activityType ||
      raw.activity_type ||
      '',
    note: a.note || raw.note || a.memo || raw.memo || '',
    level: a.level || raw.level || '',
    ability: a.ability || a.abilities || raw.ability || raw.abilities || [],
    score:
      typeof a.score === 'number'
        ? a.score
        : typeof raw.score === 'number'
        ? raw.score
        : null,
    scoreExplanation:
      a.scoreExplanation ||
      a.score_explanation ||
      raw.scoreExplanation ||
      raw.score_explanation ||
      '',
    emotionSummary: a.emotionSummary || legacyEmotion || '',
    emotionCause: a.emotionCause || a.emotion_reason || raw.emotionCause || '',
    observedBehaviors:
      a.observedBehaviors ||
      a.behavior ||
      raw.observedBehaviors ||
      '',
    emotionTags: normalizeEmotionTags(emotionTagsRaw),
    rawTextCleaned:
      a.rawTextCleaned ||
      raw.rawTextCleaned ||
      raw.log_content ||
      raw.raw_text_cleaned ||
      raw.raw_text ||
      '',
    isAiGenerated: !!(a.isAiGenerated || a.aiGenerated || raw.isAiGenerated),
  }
}

// 업로드 아이템 정규화
function hydrateUpload(raw) {
  const id =
    raw.id ||
    raw.upload_id ||
    raw.uuid ||
    String(raw.file_name || raw.filename || raw.name || Math.random())

  const fileName = raw.file_name || raw.filename || raw.name
  const studentName = raw.student_name || raw.student?.name || raw.meta?.student_name

  const uploaderName =
    raw.uploader_name ||
    raw.uploaderName ||
    raw.uploaded_by_name ||
    raw.meta?.uploader_name ||
    ''

  const uploadedAt =
    raw.created_at || raw.uploaded_at || raw.uploadDate || raw.createdAt || null

  const status = raw.status || 'queued'
  const isSuccess = status === 'success' || status === 'completed' || status === 'done'

  let progress = typeof raw.progress === 'number' ? raw.progress : raw.overall_progress
  if (isSuccess) progress = 100

  let steps = raw.steps
  if (!steps) {
    // DB 상태 기반 스텝 초기화
    if (isSuccess) {
      steps = { upload: 100, extract: 100, ocr: 100, sentiment: 100, ai: 100, save: 100 }
    } else {
      const base = typeof progress === 'number' ? progress : 0
      steps = {
        upload: base,
        // status가 processing 이상이면 추출은 끝난 것으로 간주
        extract: (status === 'processing' || base > 0) ? 100 : base,
        ocr: base,
        sentiment: base,
      }
    }
  }

  const overall = isSuccess 
    ? 100 
    : typeof progress === 'number'
      ? progress
      : Math.round((steps.upload + steps.extract + steps.ocr + steps.sentiment) / 4)

  const analysis = normalizeAnalysis(raw)

  return {
    ...raw,
    id,
    file_name: fileName,
    student_name: studentName,
    uploader_name: uploaderName,
    uploaded_at: uploadedAt,
    status,
    steps,
    overall_progress: overall,
    raw_text: analysis.rawTextCleaned || raw.raw_text || '',
    analysis,
  }
}

function formatDate(value) {
  if (!value) return ''
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toISOString().slice(0, 10)
  } catch {
    return String(value)
  }
}

function splitDuration(mins) {
  const total = Number(mins)
  if (Number.isNaN(total) || total < 0) {
    return { hours: 0, minutes: 0 }
  }
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return { hours, minutes }
}

const ACTIVITY_TYPE_PRESETS = {
  harvest: {
    label: '수확',
    icon: '🍅',
    placeholder: '예: 토마토 수확, 감자 캐기',
  },
  sowing: {
    label: '파종',
    icon: '🌱',
    placeholder: '예: 씨앗 뿌리기, 모종 심기',
  },
  manage: {
    label: '관리',
    icon: '🧺',
    placeholder: '예: 물주기, 잡초 제거, 비료 주기',
  },
  observe: {
    label: '관찰',
    icon: '👀',
    placeholder: '예: 작물 상태 관찰, 날씨 관찰',
  },
  etc: {
    label: '기타',
    icon: '✏️',
    placeholder: '예: 활동 기록 작성, 그림 그리기',
  },
}

// 활동 유형 상태 객체 생성
function buildActivityTypeState(rawTypes = null, rawDetails = null) {
  const base = {}
  Object.entries(ACTIVITY_TYPE_PRESETS).forEach(([key, config]) => {
    let selected = false
    let detail = ''

    if (rawTypes && Object.prototype.hasOwnProperty.call(rawTypes, key)) {
      const item = rawTypes[key]
      if (typeof item === 'object' && item !== null) {
        selected = item.selected ?? !!item.detail ?? false
        detail = item.detail || item.description || ''
      } else if (typeof item === 'boolean') {
        selected = item
      } else if (typeof item === 'string') {
        selected = true
        detail = item
      }
    }

    if (rawDetails && Object.prototype.hasOwnProperty.call(rawDetails, key) && !detail) {
      detail = rawDetails[key] || ''
    }

    base[key] = {
      ...config,
      selected,
      detail,
    }
  })

  return base
}

// 감정 태그 직렬화
function createDetailState(overrides = {}) {
  return {
    open: false,
    loading: false,
    upload: null,
    error: '',
    saving: false,
    saved: false,

    // 텍스트 편집
    editedText: '',

    // 날짜 / 날짜별 텍스트
    dates: [],
    activeDate: null,
    rawTextByDate: {},

    // 학생 / 분석 정보
    students: [],
    activeStudentId: null,
    analysisByStudent: {},

    ...overrides,
  }
}

const INITIAL_ACTIVITY_DETAIL_MODAL = {
  open: false,
  loading: false,
  records: [],
  summary: null,
  analysisText: '',
  error: '',
}

function getActiveStudentState(detail) {
  const students = detail.students || []
  const map = detail.analysisByStudent || {}

  let activeId = detail.activeStudentId
  if (!activeId && students.length > 0) {
    activeId = students[0].id
  }

  const current = map[activeId] || {
    analysis: {},
    activityTypes: buildActivityTypeState(),
  }

  return {
    activeId,
    analysis: current.analysis || {},
    activityTypes: current.activityTypes || buildActivityTypeState(),
  }
}

function getCurrentRawText(detail) {
  const upload = detail.upload || {}

  const baseRaw =
    (detail.editedText && detail.editedText.trim()) ||
    upload.raw_text ||
    upload.analysis?.rawTextCleaned ||
    ''

  const dates = detail.dates || []
  const activeDate = detail.activeDate
  const rawByDate = detail.rawTextByDate || {}

  // 날짜 탭이 없으면 전체 텍스트 사용
  if (!dates.length || !activeDate) {
    return baseRaw
  }

  // 날짜가 1개일 때: 그 날짜 텍스트가 있으면 우선 사용
  if (dates.length === 1) {
    return rawByDate[activeDate] || baseRaw
  }

  // 날짜가 여러 개일 때: 선택된 날짜 텍스트 우선
  return rawByDate[activeDate] || baseRaw
}

// -------------------- 페이지 컴포넌트 --------------------

export default function UploadPage() {
  const fileRef = useRef(null)

  const [uploads, setUploads] = useState(() => uploadsCache || [])
  const [loading, setLoading] = useState(() => !uploadsCache)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const [detail, setDetail] = useState(() => createDetailState())
  const [activityDetailModal, setActivityDetailModal] = useState(
    INITIAL_ACTIVITY_DETAIL_MODAL,
  )
  const [downloading, setDownloading] = useState(false)
  const [emotionKeywords, setEmotionKeywords] = useState([])

  // Supabase 학생 목록 (드롭다운용)
  const [studentsMaster, setStudentsMaster] = useState([])
  const [studentPickerOpen, setStudentPickerOpen] = useState(false)
  const [studentPickerValue, setStudentPickerValue] = useState('')

  // Gemini AI 관련 상태
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiRunningUploadId, setAiRunningUploadId] = useState(null)

  // 🔹 날짜 탭 선택 (이제 컴포넌트 내부에서 setDetail 사용)
  const handleSelectDate = dateStr => {
    setDetail(prev => ({
      ...prev,
      activeDate: dateStr,
      saved: false,
    }))
  }

  // 업로드 + 캐시 동시 갱신
  function updateUploads(updater) {
    setUploads(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      uploadsCache = next
      return next
    })
  }

  // 개별 업로드의 단계(progress)를 업데이트하는 헬퍼
  function updateUploadSteps(uploadId, stepUpdater) {
    updateUploads(prev =>
      prev.map(item => {
        if (item.id !== uploadId) return item
        const prevSteps = item.steps || {}
        const nextSteps =
          typeof stepUpdater === 'function'
            ? stepUpdater(prevSteps)
            : { ...prevSteps, ...stepUpdater }
        const overall = computeOverallFromSteps(
          nextSteps,
          item.overall_progress,
        )
        return {
          ...item,
          steps: nextSteps,
          overall_progress: overall,
        }
      }),
    )
  }

  // 업로드 목록 로드
  async function fetchUploads() {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/uploads')
      const items = normalizeUploads(data).map(hydrateUpload)
      updateUploads(items)
    } catch (e) {
      console.error(e)
      setError('업로드 목록을 불러오는 중 오류가 발생했습니다.')
      updateUploads([])
    } finally {
      setLoading(false)
    }
  }

  // 감정 키워드 세트 로드 (emotion_keywords)
  async function loadEmotionKeywords() {
    try {
      const data = await apiFetch('/rest/v1/tags?select=*')

      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
        ? data.items
        : []

      const normalized = rows
        .map(row => ({
          id: row.id || row.key || row.value || row.name,
          label: row.name || row.label || row.value || row.key,
        }))
        .filter(item => item.label)

      if (normalized.length > 0) {
        setEmotionKeywords(normalized)
      } else {
        setEmotionKeywords([])
      }
    } catch (e) {
      console.error(e)
      setEmotionKeywords([])
    }
  }

  // Supabase 학생 목록 로드
  async function loadStudentsMaster() {
    try {
      const data = await apiFetch('/api/students?limit=500')
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
      const mapped = items
        .map(stu => ({
          id: String(stu.id),
          name: stu.name || stu.real_name || stu.nickname || '이름 없는 학생',
        }))
        .filter(s => s.id && s.name)
      setStudentsMaster(mapped)
    } catch (e) {
      console.error('학생 목록 로드 오류:', e)
      setStudentsMaster([])
    }
  }

  useEffect(() => {
    if (!uploadsCache) {
      fetchUploads()
    } else {
      updateUploads(uploadsCache)
      setLoading(false)
    }
    loadEmotionKeywords()
    loadStudentsMaster()
  }, [])

  // 🔹 상세 편집 모달이 열리면 자동으로 AI 분석 실행
  useEffect(() => {
    if (!detail.open || detail.loading || !detail.upload) return
    if (detail.autoAiRequested) return

    const sourceText =
      (detail.editedText && detail.editedText.trim()) ||
      detail.upload.raw_text ||
      detail.upload.analysis?.rawTextCleaned ||
      ''

    if (!sourceText) return

    // 이 모달에서 한 번만 자동 실행
    setDetail(prev => ({ ...prev, autoAiRequested: true }))
    handleRunAiExtraction()
  }, [
    detail.open,
    detail.loading,
    detail.upload,
    detail.editedText,
    detail.autoAiRequested,
  ])

// ---------- 파일 업로드 (병렬 처리 & 즉시 갱신 개선) ----------

  async function handleFiles(files) {
    const list = Array.from(files || [])
    if (list.length === 0) return
    
    // 1. uploading 락 제거 (여러 번 드래그 허용)
    // 대신 UI에 로딩 인디케이터를 위해 카운트나 상태를 다르게 관리할 수 있으나,
    // 여기서는 단순화를 위해 uploading 상태는 '최소 하나라도 업로드 중이면 true'로 유지하되
    // 진입 차단(if uploading return)은 제거했습니다.
    
    setUploading(true) 
    setError('') // 전역 에러 초기화 (개별 에러는 로그로 처리 권장)

    // 2. 병렬 업로드 처리
    const uploadPromises = list.map(async (file) => {
      const form = new FormData()
      form.append('file', file)

      try {
        const rawUser = localStorage.getItem('user')
        if (rawUser) {
          const parsed = JSON.parse(rawUser)
          if (parsed?.id) form.append('uploaded_by', String(parsed.id))
        }
      } catch { /* ignore */ }

      try {
        // 개별 파일 업로드 요청
        await apiFetch('/uploads', {
          method: 'POST',
          body: form,
          _formName: file.name,
        })
        
        // 3. 하나 완료될 때마다 목록 갱신 (UX 향상)
        // (너무 빈번한 호출이 부담된다면 Promise.all 이후로 옮겨도 됨)
        await fetchUploads() 
        
      } catch (e) {
        console.error(`파일 업로드 실패 (${file.name}):`, e)
        // 여기서 alert를 띄우면 사용자 경험을 해칠 수 있으므로 에러 로그만 남기거나
        // 별도의 '실패한 파일 목록' 상태를 관리하는 것이 좋습니다.
      }
    })

    try {
      setLoading(true) // 목록 로딩 표시
      await Promise.all(uploadPromises) // 병렬 실행 대기
      
      // 4. 최종 정렬 및 최신 파일 열기
      const all = uploadsCache || []
      if (all.length > 0) {
        const sorted = [...all].sort((a, b) => {
           const ad = new Date(a.uploaded_at || a.created_at || 0).getTime()
           const bd = new Date(b.uploaded_at || b.created_at || 0).getTime()
           return bd - ad
        })
        const newest = sorted[0]
        // 방금 올린 파일이 있으면 열기 (선택 사항)
        // if (newest) openDetail(newest) 
      }
    } catch (err) {
      console.error('업로드 프로세스 전체 에러:', err)
      setError('일부 파일을 업로드하는 중 문제가 발생했습니다.')
    } finally {
      setLoading(false)
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files)
    }
  }

  // ---------- 업로드 삭제 ----------

  async function handleDeleteUpload(uploadId) {
    if (!uploadId) return
    const ok = window.confirm('해당 업로드 기록을 삭제하시겠습니까?')
    if (!ok) return

    try {
      setLoading(true)
      await apiFetch(`/uploads/${uploadId}`, {
        method: 'DELETE',
      })
      updateUploads(prev => prev.filter(u => u.id !== uploadId))
    } catch (e) {
      console.error(e)
      alert('업로드 삭제 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  // ---------- 상세보기 모달 초기화 ----------

  async function openDetail(upload) {
    // 1) 먼저 draft 캐시가 있으면 그걸 복원 (API 호출 X)
    const draft = upload?.id ? detailDrafts[upload.id] : null
    if (draft) {
      setAiError('')
      setStudentPickerOpen(false)
      setStudentPickerValue('')
      setDetail({
        ...draft,
        open: true,
        loading: false,
      })
      return
    }

    // 2) 서버에서 최신 데이터 불러오기
    setDetail(createDetailState({ open: true, loading: true }))
    setAiError('')
    setStudentPickerOpen(false)
    setStudentPickerValue('')

    try {
      const uploadRes = await apiFetch(`/uploads/${upload.id}`)

      const hydrated = hydrateUpload({ ...upload, ...(uploadRes || {}) })

      const initialText =
        uploadRes?.rawText ||
        uploadRes?.raw_text ||
        hydrated.raw_text ||
        hydrated.analysis?.rawTextCleaned ||
        ''

      const serverLogEntries =
        uploadRes?.log_entries || uploadRes?.entries || []

      const serverStudents =
        (uploadRes &&
          (uploadRes.students || uploadRes.student_list || [])) ||
        hydrated.analysis?.students ||
        []

      // 🔹 날짜 / 날짜별 raw text 구성
      const dateSet = new Set()
      const rawTextByDate = {}

      const fromEntries = Array.isArray(serverLogEntries)
        ? serverLogEntries
        : []

      // 2-1) log_entries 에 저장된 날짜 기준
      fromEntries.forEach(entry => {
        const dateValue =
          entry.log_date || entry.activity_date || entry.date
        const dateKey = dateValue ? String(dateValue).slice(0, 10) : null
        if (!dateKey) return

        dateSet.add(dateKey)

        const snippet =
          entry.log_content ||
          entry.raw_text ||
          ''

        if (!snippet) return

        if (!rawTextByDate[dateKey]) {
          rawTextByDate[dateKey] = snippet
        } else {
          rawTextByDate[dateKey] = `${rawTextByDate[dateKey]}\n\n${snippet}`
        }
      })

      // 2-2) 원본 텍스트에서 날짜를 파싱해서 추가 (텍스트에 적힌 날짜로 무조건 탭 생성)
      const textDates = parseDatesFromText(initialText)
      textDates.forEach(d => {
        if (!dateSet.has(d)) {
          dateSet.add(d)
          // 날짜별 텍스트가 따로 없으면 일단 전체 텍스트를 기본값으로 연결
          if (!rawTextByDate[d]) {
            rawTextByDate[d] = initialText
          }
        }
      })

      const dates = Array.from(dateSet).sort()
      const activeDate = dates[0] || null

      // 🔹 학생 목록 구성 (log_entries + 서버가 내려준 students 기반)
      const entryStudents = fromEntries.map((entry, idx) => ({
        id: String(
          entry.student_id || entry.student?.id || `stu-entry-${idx + 1}`,
        ),
        name:
          entry.student_name ||
          entry.student?.name ||
          `학생 ${idx + 1}`,
      }))

      const explicitStudents = Array.isArray(serverStudents)
        ? serverStudents.map((s, idx) => ({
            id: String(
              s.id ||
                s.student_id ||
                s.uuid ||
                s.key ||
                `stu-${idx + 1}`,
            ),
            name:
              s.name ||
              s.student_name ||
              s.realName ||
              s.label ||
              `학생 ${idx + 1}`,
          }))
        : []

      let students = []
      if (entryStudents.length === 0 && explicitStudents.length === 0) {
        // 🔸 더 이상 "학생 미확인" 같은 기본 탭을 만들지 않는다.
        //     → AI 분석 또는 "학생 추가" 버튼으로만 학생 탭이 생김
        students = []
      } else {
        const map = new Map()
        ;[...explicitStudents, ...entryStudents].forEach(stu => {
          if (!map.has(stu.id)) {
            map.set(stu.id, stu)
          }
        })
        students = Array.from(map.values())
      }

      // 🔹 학생별 분석 정보 재구성
      const analysisByStudent = {}

      if (fromEntries.length > 0) {
        fromEntries.forEach(entry => {
          const stuId = String(
            entry.student_id || entry.student?.id || students[0]?.id,
          )
          if (!stuId) return

          const normalized = normalizeAnalysis(entry)

          const activityTags = Array.isArray(entry.activity_tags)
            ? entry.activity_tags
            : []
          const activityTypesFromTags = {}
          activityTags.forEach(tagLabel => {
            const key = Object.keys(ACTIVITY_TYPE_PRESETS).find(
              k => ACTIVITY_TYPE_PRESETS[k].label === tagLabel,
            )
            if (!key) return
            activityTypesFromTags[key] = {
              ...ACTIVITY_TYPE_PRESETS[key],
              selected: true,
              detail: '',
            }
          })

          analysisByStudent[stuId] = {
            analysis: normalized,
            activityTypes: {
              ...buildActivityTypeState(),
              ...activityTypesFromTags,
            },
          }
        })
      }

      // log_entries 기반 정보가 없으면, 업로드 기본 분석값으로 초기화
      if (Object.keys(analysisByStudent).length === 0) {
        const base = hydrated.analysis || {}
        students.forEach(stu => {
          analysisByStudent[stu.id] = {
            analysis: { ...base },
            activityTypes: buildActivityTypeState(
              uploadRes?.activity_types || uploadRes?.activityTypes,
              uploadRes?.activity_type_details ||
                uploadRes?.activityTypeDetails,
            ),
          }
        })
      }

      const activeStudentId =
        uploadRes?.activeStudentId ||
        uploadRes?.active_student_id ||
        (students[0] && students[0].id) ||
        null

      setDetail(
        createDetailState({
          open: true,
          loading: false,
          upload: hydrated,
          editedText: initialText,
          dates,
          activeDate,
          rawTextByDate,
          students,
          activeStudentId,
          analysisByStudent,
        }),
      )

      // 텍스트를 불러온 시점에서 "텍스트 추출" 단계 완료로 간주
      if (initialText && initialText.trim()) {
        updateUploadSteps(hydrated.id, prevSteps => ({
          ...prevSteps,
          extract: 100,
        }))
      }
    } catch (err) {
      console.error(err)

      const hydrated = hydrateUpload(upload)
      const initialText =
        hydrated.raw_text || hydrated.analysis?.rawTextCleaned || ''

      // 🔹 실패 시에도 텍스트에서 날짜를 추출해서 탭 생성
      const textDates = parseDatesFromText(initialText)
      const dates = textDates
      const activeDate = dates[0] || null
      const rawTextByDate = {}
      dates.forEach(d => {
        rawTextByDate[d] = initialText
      })

      // 기본 학생 탭은 만들지 않는다. (학생은 수동 추가 또는 AI 분석으로 생성)
      const students = []
      const analysisByStudent = {}

      setDetail(
        createDetailState({
          open: true,
          loading: false,
          upload: hydrated,
          editedText: initialText,
          dates,
          activeDate,
          rawTextByDate,
          students,
          activeStudentId: null,
          analysisByStudent,
          error:
            '상세 정보를 불러오지 못했습니다. 텍스트만 편집 가능합니다.',
        }),
      )
      if (initialText && initialText.trim()) {
        updateUploadSteps(hydrated.id, prevSteps => ({
          ...prevSteps,
          extract: 100,
        }))
      }
    }
  }

  function closeDetail() {
    // [수정] 작업 중 닫기 방지/경고
    if (detail.saving || aiLoading) {
      const proceed = window.confirm(
        '현재 작업(AI 분석 또는 저장)이 진행 중입니다. 창을 닫으면 작업이 중단되거나 데이터가 저장되지 않을 수 있습니다. 정말 닫으시겠습니까?'
      )
      if (!proceed) return
    } else if (!detail.saved && (detail.editedText || (detail.students && detail.students.length > 0))) {
        // (선택 사항) 저장되지 않은 변경사항이 있을 때 경고하고 싶다면 여기에 추가
    }
    setAiError('')
    setStudentPickerOpen(false)
    setStudentPickerValue('')

    // 🔹 현재 편집 상태를 draft 캐시에 저장 (업로드별)
    setDetail(prev => {
      if (prev.upload && prev.upload.id) {
        detailDrafts[prev.upload.id] = {
          ...prev,
          open: false,
          loading: false,
        }
      }
      return createDetailState()
    })
  }

  // ---------- 학생 탭 ----------

  function handleSelectStudent(studentId) {
    setDetail(prev => {
      if (!prev.students.find(s => s.id === studentId)) return prev
      return {
        ...prev,
        activeStudentId: studentId,
        saved: false,
      }
    })
  }

  // 학생 추가 버튼 클릭 시: Supabase 학생 목록이 있으면 드롭다운 노출, 없으면 기존 prompt fallback
  function handleAddStudent() {
    if (studentsMaster && studentsMaster.length > 0) {
      setStudentPickerOpen(prev => !prev)
      return
    }

    const name = window.prompt('추가할 학생 이름을 입력하세요.')
    if (!name || !name.trim()) return

    const trimmed = name.trim()

    setDetail(prev => {
      const exists = (prev.students || []).find(s => s.name === trimmed)
      if (exists) {
        return {
          ...prev,
          activeStudentId: exists.id,
          saved: false,
        }
      }

      const id = `local-${Date.now()}`
      const map = prev.analysisByStudent || {}

      let baseState = {
        analysis: {},
        activityTypes: buildActivityTypeState(),
      }

      if (prev.activeStudentId && map[prev.activeStudentId]) {
        const from = map[prev.activeStudentId]
        baseState = {
          analysis: { ...(from.analysis || {}) },
          activityTypes: { ...(from.activityTypes || {}) },
        }
      }

      return {
        ...prev,
        students: [...(prev.students || []), { id, name: trimmed }],
        analysisByStudent: {
          ...map,
          [id]: baseState,
        },
        activeStudentId: id,
        saved: false,
      }
    })
  }

  // 드롭다운에서 선택한 Supabase 학생을 실제 탭으로 추가
  function handleAddStudentFromPicker() {
    if (!studentPickerValue) {
      alert('학생을 선택해 주세요.')
      return
    }

    const master = studentsMaster.find(
      s => String(s.id) === String(studentPickerValue),
    )
    if (!master) return

    setDetail(prev => {
      const existing = (prev.students || []).find(
        s => String(s.id) === String(master.id),
      )

      const map = prev.analysisByStudent || {}

      let baseState = {
        analysis: {},
        activityTypes: buildActivityTypeState(),
      }

      if (prev.activeStudentId && map[prev.activeStudentId]) {
        const from = map[prev.activeStudentId]
        baseState = {
          analysis: { ...(from.analysis || {}) },
          activityTypes: { ...(from.activityTypes || {}) },
        }
      }

      const nextStudents = existing
        ? prev.students
        : [...(prev.students || []), { id: String(master.id), name: master.name }]

      const nextAnalysisByStudent = existing
        ? map
        : {
            ...map,
            [String(master.id)]: baseState,
          }

      return {
        ...prev,
        students: nextStudents,
        analysisByStudent: nextAnalysisByStudent,
        activeStudentId: String(master.id),
        saved: false,
      }
    })

    setStudentPickerOpen(false)
    setStudentPickerValue('')
  }

  function handleRemoveStudent(studentId) {
    // [수정] 삭제 확인 Confirm 추가
    const target = detail.students.find(s => s.id === studentId)
    const name = target ? target.name : '학생'
    if (!window.confirm(`'${name}' 학생의 분석 데이터를 삭제하시겠습니까?`)) {
        return
    }

    setDetail(prev => {
      const nextStudents = (prev.students || []).filter(
        s => s.id !== studentId,
      )
      const nextAnalysisByStudent = { ...(prev.analysisByStudent || {}) }
      delete nextAnalysisByStudent[studentId]

      let nextActiveId = prev.activeStudentId
      if (studentId === prev.activeStudentId) {
        nextActiveId = nextStudents[0]?.id || null
      }

      return {
        ...prev,
        students: nextStudents,
        analysisByStudent: nextAnalysisByStudent,
        activeStudentId: nextActiveId,
        saved: false,
      }
    })
  }

  // ---------- 학생별 분석 업데이트 ----------

  function updateActiveStudent(updater) {
    setDetail(prev => {
      const students = prev.students || []
      let activeId = prev.activeStudentId
      if (!activeId && students.length > 0) {
        activeId = students[0].id
      }
      if (!activeId) return prev

      const map = prev.analysisByStudent || {}
      const current =
        map[activeId] || {
          analysis: {},
          activityTypes: buildActivityTypeState(),
        }

      const next = updater(current)

      return {
        ...prev,
        activeStudentId: activeId,
        analysisByStudent: {
          ...map,
          [activeId]: {
            ...current,
            ...next,
          },
        },
        saved: false,
      }
    })
  }

  function toggleEmotionTagInDetail(label) {
    const trimmed = String(label || '').trim()
    if (!trimmed) return

    updateActiveStudent(current => {
      const baseAnalysis = current.analysis || {}
      const currentTags = Array.isArray(baseAnalysis.emotionTags)
        ? baseAnalysis.emotionTags
        : []
      const exists = currentTags.includes(trimmed)
      const nextTags = exists
        ? currentTags.filter(item => item !== trimmed)
        : [...currentTags, trimmed]

      return {
        ...current,
        analysis: {
          ...baseAnalysis,
          emotionTags: nextTags,
        },
      }
    })
  }

  async function addEmotionKeywordInSupabase(label) {
    const trimmed = String(label || '').trim()
    if (!trimmed) return

    const exists = emotionKeywords.find(item => item.label === trimmed)
    if (exists) {
      toggleEmotionTagInDetail(trimmed)
      return
    }

    try {
      const response = await apiFetch('/rest/v1/tags', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ name: trimmed }),
      })

      const saved = Array.isArray(response) ? response[0] : response
      const newItem = {
        id: saved?.id || trimmed,
        label: saved?.name || saved?.label || trimmed,
      }

      setEmotionKeywords(prev => [...prev, newItem])
      toggleEmotionTagInDetail(newItem.label)
    } catch (e) {
      console.error(e)
      const fallbackItem = { id: trimmed, label: trimmed }
      setEmotionKeywords(prev => [...prev, fallbackItem])
      toggleEmotionTagInDetail(trimmed)
    }
  }

  function toggleActivityTypeSelection(key) {
    updateActiveStudent(current => {
      const nextMap = { ...(current.activityTypes || {}) }
      const currentItem =
        nextMap[key] || ACTIVITY_TYPE_PRESETS[key] || { label: key }
      nextMap[key] = {
        ...currentItem,
        selected: !currentItem.selected,
      }
      return {
        ...current,
        activityTypes: nextMap,
      }
    })
  }

  function updateActivityTypeDetail(key, detailText) {
    updateActiveStudent(current => ({
      ...current,
      activityTypes: {
        ...(current.activityTypes || {}),
        [key]: {
          ...(current.activityTypes?.[key] ||
            ACTIVITY_TYPE_PRESETS[key] || {
              label: key,
            }),
          detail: detailText,
        },
      },
    }))
  }

  function updateEditedAnalysis(patch) {
    updateActiveStudent(current => ({
      ...current,
      analysis: {
        ...(current.analysis || {}),
        ...patch,
      },
    }))
  }

  // ---------- 텍스트 다운로드 ----------

  async function handleDownloadOriginal() {
    if (!detail.upload || downloading) return
    setDownloading(true)
    try {
      const text =
        (detail.editedText && detail.editedText.trim()) ||
        detail.upload.raw_text ||
        detail.upload.analysis?.rawTextCleaned ||
        ''

      const blob = new Blob([text], {
        type: 'text/plain;charset=utf-8',
      })

      const url = URL.createObjectURL(blob)
      const baseName =
        detail.upload.file_name?.replace(/\.[^.]+$/, '') || 'extracted-text'
      const a = document.createElement('a')
      a.href = url
      a.download = `${baseName}.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      console.error(err)
      alert('텍스트 파일을 다운로드하는 중 오류가 발생했습니다.')
    } finally {
      setDownloading(false)
    }
  }

// ---------- Gemini AI: 텍스트 → 활동 레코드 자동 구조화 ----------

  function applyAiExtraction(records) {
    if (!Array.isArray(records)) return

    setDetail(prev => {
      // 1) 기존 상태 복사
      const prevStudents = prev.students || []
      const prevAnalysisByStudent = prev.analysisByStudent || {}
      const studentsByName = new Map(prevStudents.map(stu => [stu.name, stu]))

      const nextStudents = [...prevStudents]
      const nextAnalysisByStudent = { ...prevAnalysisByStudent }

      // 2) 날짜 탭 자동 생성을 위한 Set (AI가 찾은 날짜 수집)
      // [수정] 긴 코드에 없던 기능: AI가 찾은 날짜를 탭으로 만듦
      const foundDates = new Set(prev.dates || [])

      records.forEach((rec, idx) => {
        if (!rec) return

        // Step 1: 날짜 처리
        if (rec.date) {
          foundDates.add(rec.date)
        }

        // Step 2: 학생 처리
        const name = (rec.student_name && String(rec.student_name).trim()) || `학생 ${idx + 1}`
        
        let student = studentsByName.get(name)
        if (!student) {
          student = {
            id: `ai-${Date.now()}-${idx + 1}`,
            name,
          }
          studentsByName.set(name, student)
          nextStudents.push(student)
        }

        const prevState = nextAnalysisByStudent[student.id] || {
          analysis: {},
          activityTypes: buildActivityTypeState(),
        }

        // Step 3: 활동별 감정 추출 (배열/객체/문자열 모두 대응)
        const emotionItems = Array.isArray(rec.emotions) 
          ? rec.emotions 
          : Array.isArray(rec.emotion_tags) 
            ? rec.emotion_tags 
            : []
        
        const emotionTags = emotionItems.map(e => {
            if (typeof e === 'string') return e;
            return e?.label || e?.name || e?.tag || '';
        }).filter(Boolean);
        
        const mainEmotion = emotionTags[0] || '';

        // Step 4: 활동 유형 자동 체크
        let activityTypes = prevState.activityTypes || buildActivityTypeState()
        if (rec.activity_type) {
          const key = Object.keys(ACTIVITY_TYPE_PRESETS).find(
            k => ACTIVITY_TYPE_PRESETS[k].label === rec.activity_type || rec.activity_type.includes(ACTIVITY_TYPE_PRESETS[k].label)
          )
          if (key) {
            activityTypes = {
              ...activityTypes,
              [key]: {
                ...ACTIVITY_TYPE_PRESETS[key],
                selected: true,
                // [보존] 긴 코드의 장점: teacher_notes도 detail에 넣어줌
                detail: rec.teacher_notes || rec.raw_activity_text || '', 
              },
            }
          }
        }

        // Step 5: 시간(분) 추출 - [보존] 긴 코드의 꼼꼼한 체크 로직을 한 줄로 통합
        // minutes, duration_minutes, ability_analysis.total_minutes 순서로 체크
        const minutes = 
            (typeof rec.minutes === 'number' ? rec.minutes : null) ??
            (typeof rec.duration_minutes === 'number' ? rec.duration_minutes : null) ??
            (rec.ability_analysis && typeof rec.ability_analysis.total_minutes === 'number' ? rec.ability_analysis.total_minutes : 0);

        // Step 6: 특이사항(Note) 추출 - [보존] 여러 필드 후보군 모두 체크
        const noteText = 
            rec.teacher_comment || 
            rec.teacher_notes || 
            rec.raw_activity_text || 
            prevState.analysis?.note || 
            '';

        // Step 7: 최종 상태 매핑
        nextAnalysisByStudent[student.id] = {
          analysis: {
            ...(prevState.analysis || {}),
            isAiGenerated: true,
            studentName: name,
            // 날짜가 없으면 기존 선택 날짜 혹은 오늘
            date: rec.date || prev.activeDate || new Date().toISOString().slice(0, 10),
            activityName: rec.activity_title || rec.activityName || prevState.analysis?.activityName || '',
            activityType: rec.activity_type || prevState.analysis?.activityType || '', 
            durationMinutes: minutes, 
            note: noteText, 
            emotionSummary: mainEmotion,
            emotionTags: emotionTags,
          },
          activityTypes, 
        }
      })

      // 3) 날짜 탭 정렬 및 업데이트
      const sortedDates = Array.from(foundDates).sort()
      let nextActiveDate = prev.activeDate
      if (!nextActiveDate && sortedDates.length > 0) {
        nextActiveDate = sortedDates[0]
      }

      // 4) 학생 선택 (AI가 찾은 첫 번째 학생으로 포커스)
      let nextActiveStudentId = prev.activeStudentId
      const hasPrevActive = nextActiveStudentId && nextStudents.some(stu => stu.id === nextActiveStudentId)
      if (!hasPrevActive) {
        nextActiveStudentId = nextStudents[0] ? nextStudents[0].id : null
      }

      return {
        ...prev,
        dates: sortedDates,
        activeDate: nextActiveDate,
        students: nextStudents,
        analysisByStudent: nextAnalysisByStudent,
        activeStudentId: nextActiveStudentId,
        saved: false,
      }
    })
  }

  // ---------- AI 수동/자동 실행 통합 함수 ----------

  async function handleRunAiExtraction() {
    if (!detail.upload || aiLoading) return

    // 1. 분석할 텍스트 가져오기 (현재 선택된 날짜 탭 기준)
    const sourceText = getCurrentRawText(detail)

    if (!sourceText) {
      alert('분석할 텍스트가 없습니다. 먼저 업로드 텍스트를 불러오거나 작성해 주세요.')
      return
    }

    const currentUploadId = detail.upload.id

    try {
      setAiLoading(true)
      setAiError('')
      setAiRunningUploadId(currentUploadId)

      // 진행률 업데이트: AI 준비 (20%)
      if (currentUploadId) {
        updateUploadSteps(currentUploadId, prev => ({
          ...prev,
          ai: Math.max(prev.ai || 0, 20),
        }))
      }

      // 진행률 업데이트: 데이터 전송 (40%)
      if (currentUploadId) {
        updateUploadSteps(currentUploadId, prev => ({
          ...prev,
          ai: Math.max(prev.ai || 0, 40),
        }))
      }

      // 2. Gemini API 호출
      const res = await extractRecordsWithGemini({
        raw_text: sourceText,
        file_name: detail.upload.file_name,
      })

      // 진행률 업데이트: 결과 정리 중 (70%)
      if (currentUploadId) {
        updateUploadSteps(currentUploadId, prev => ({
          ...prev,
          ai: Math.max(prev.ai || 0, 70),
        }))
      }

      const records = res?.parsed?.records || res?.records || []

      if (!Array.isArray(records) || records.length === 0) {
        // AI가 빈 결과를 줄 경우 조용히 넘어가거나 알림
        console.warn('AI 분석 결과가 비어 있습니다.')
        return
      }

      // 3. 분석 결과 UI 적용 (기존에 만든 applyAiExtraction 함수 활용)
      applyAiExtraction(records)

      // 진행률 업데이트: 완료 (100%)
      if (currentUploadId) {
        updateUploadSteps(currentUploadId, prevSteps => ({
          ...prevSteps,
          ai: 100,
        }))
      }
    } catch (e) {
      console.error(e)
      setAiError('AI 분석 중 오류가 발생했습니다.')
      alert('AI 분석 중 오류가 발생했습니다.')
    } finally {
      setAiLoading(false)
      setAiRunningUploadId(null)
    }
  }

  // ---------- 활동 유형 상세 모달 ----------

  async function openActivityTypeSummary() {
    if (!detail.upload) return
    setActivityDetailModal({
      ...INITIAL_ACTIVITY_DETAIL_MODAL,
      open: true,
      loading: true,
    })
    try {
      const data = await apiFetch(`/activity_types?upload_id=${detail.upload.id}`)
      const records = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
        ? data
        : Array.isArray(data?.records)
        ? data.records
        : []

      setActivityDetailModal({
        open: true,
        loading: false,
        records,
        summary: data?.summary || data?.stats || null,
        analysisText:
          data?.analysis ||
          data?.description ||
          data?.insight ||
          `${detail.upload.student_name || '학생'} 활동 데이터 집계입니다.`,
        error: '',
      })
    } catch (err) {
      console.error(err)
      setActivityDetailModal({
        open: true,
        loading: false,
        records: [],
        summary: null,
        analysisText: '',
        error: '활동 유형 상세 데이터를 불러오지 못했습니다.',
      })
    }
  }

  function closeActivityTypeModal() {
    setActivityDetailModal(INITIAL_ACTIVITY_DETAIL_MODAL)
  }

// ---------- DB 저장 ----------

  async function handleSaveLogEntry() {
    if (!detail.upload || detail.saving) return

    const { activeId } = getActiveStudentState(detail)
    if (!activeId) {
      alert('학생 정보가 없어 저장할 수 없습니다. (학생 탭 필요)')
      return
    }

    const baseRawText =
      (detail.editedText && detail.editedText.trim()) ||
      detail.upload.raw_text ||
      detail.upload.analysis?.rawTextCleaned ||
      ''

    const dates = detail.dates || []
    const rawByDate = detail.rawTextByDate || {}
    const hasDateTabs = dates.length > 0

    const todayStr = new Date().toISOString().slice(0, 10)

    // 저장할 데이터(payload) 구성
    const logEntries = (detail.students || []).map(stu => {
      const state =
        detail.analysisByStudent?.[stu.id] || {
          analysis: {},
          activityTypes: buildActivityTypeState(),
        }
      const analysis = state.analysis || {}
      const activityTypes = state.activityTypes || buildActivityTypeState()

      const selectedActivityLabels = Object.entries(activityTypes)
        .filter(([, item]) => item.selected)
        .map(([, item]) => item.label || '')
        .filter(Boolean)

      // 감정 태그 직렬화
      const emotionTags = serializeEmotionTags(analysis.emotionTags)

      const { hours, minutes } = splitDuration(analysis.durationMinutes)
      const durationMinutes =
        typeof analysis.durationMinutes === 'number'
          ? analysis.durationMinutes
          : hours * 60 + minutes

      const logDate =
        analysis.date ||
        detail.upload?.uploaded_at ||
        detail.upload?.created_at ||
        todayStr

      const dateKey = logDate ? String(logDate).slice(0, 10) : null

      // 날짜 탭이 있으면 해당 날짜 텍스트 사용, 없으면 전체 텍스트 사용
      const logContent =
        (hasDateTabs && dateKey && rawByDate[dateKey]) || baseRawText

      // 대표 감정: emotionSummary > emotionTags[0]
      const primaryEmotion =
        (analysis.emotionSummary && analysis.emotionSummary.trim()) ||
        (emotionTags[0] || '')

      const relatedMetrics = {
        duration_minutes: durationMinutes || null,
        activity_name: analysis.activityName || '',
        activity_type: analysis.activityType || '',
        note: analysis.note || '',
        level: analysis.level || '',
        ability: Array.isArray(analysis.ability) ? analysis.ability : [],
        score: typeof analysis.score === 'number' ? analysis.score : null,
        score_explanation: analysis.scoreExplanation || '',
        emotionTags,
        emotionSummary: primaryEmotion || '',
        isAiGenerated: !!analysis.isAiGenerated,
      }

      return {
        student_id: stu.id,
        student_name: stu.name,
        log_date: logDate,
        emotion_tag: primaryEmotion || '',
        emotion_tags: emotionTags,
        activity_tags: selectedActivityLabels,
        log_content: logContent,
        related_metrics: relatedMetrics,
      }
    })

    const payload = {
      upload_id: detail.upload.id,
      file_name: detail.upload.file_name,
      raw_text: baseRawText,
      log_entries: logEntries,
    }

    // 실제 API 호출 및 상태 업데이트
    try {
      const uploadId = detail.upload.id
      setDetail(prev => ({ ...prev, saving: true }))

      await apiFetch(`/uploads/${uploadId}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (uploadId && detailDrafts[uploadId]) delete detailDrafts[uploadId]

      // 현재 상세창 상태 업데이트 (저장됨 표시)
      setDetail(prev => ({
        ...prev,
        saving: false,
        saved: true,
        upload: {
          ...prev.upload,
          raw_text: baseRawText,
          log_entries: logEntries,
        },
      }))

      // 목록(업로드 현황)의 진행 상태도 100% 완료로 업데이트
      updateUploads(prev =>
        prev.map(item => {
          if (item.id !== uploadId) return item
          const firstEntry = logEntries[0]
          return {
            ...item,
            raw_text: baseRawText,
            student_name: firstEntry?.student_name || item.student_name,
            // 3개 과정(텍스트 추출, AI 분석, DB 저장) 완료
            status: 'success',
            progress: 100,
            overall_progress: 100,
            steps: {
              ...(item.steps || {}),
              upload: 100,
              extract: 100,
              ocr: 100,
              sentiment: 100,
              ai: 100,
              save: 100,
            },
          }
        })
      )

      alert('데이터가 데이터베이스(log_entries)에 저장되었습니다.')
      
      // 목록 최신화
      await fetchUploads()

    } catch (e) {
      console.error(e)
      setDetail(prev => ({ ...prev, saving: false, saved: false }))
      alert('저장 요청 중 오류가 발생했습니다.')
    }
  }

  // ---------- 렌더링 ----------

  const safeUploads = Array.isArray(uploads) ? uploads : []

  return (
    <Layout title="">
      {/* 업로드 영역 */}
      <section className="upload-hero">
        <div
          className={dragOver ? 'uploader uploader-drag' : 'uploader'}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={e => {
            e.preventDefault()
            setDragOver(false)
          }}
          onDrop={handleDrop}
        >
          {uploading ? (
            <>
              <div
                style={{
                  fontSize: 40,
                  marginTop: 12,
                  marginBottom: 12,
                }}
              >
                ⏳
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                파일을 변환하는 중입니다...
              </div>
              <div className="muted">
                텍스트를 추출하고 있어요. 잠시만 기다려 주세요.
              </div>
            </>
          ) : (
            <>
              <div
                style={{
                  fontSize: 40,
                  marginTop: 12,
                  marginBottom: 12,
                }}
              >
                📄
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                PDF / TXT 파일을 선택하거나 드래그하세요
              </div>
              <div className="muted">최대 10MB</div>
            </>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          multiple
          style={{ display: 'none' }}
          onChange={e => e.target.files && handleFiles(e.target.files)}
        />
      </section>

      {/* 업로드 현황 리스트 */}
      <section className="upload-status-section">
        <div className="upload-status-header">
          <h2 className="section-title">업로드 현황</h2>
        </div>

        {loading && (
          <div className="muted" style={{ marginTop: 8 }}>
            불러오는 중입니다...
          </div>
        )}
        {error && (
          <div className="error" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}

        <div className="upload-list" style={{ marginTop: 16 }}>
          {safeUploads.length === 0 && !loading && !error && (
            <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
              아직 업로드된 파일이 없습니다.
            </div>
          )}

          {safeUploads.map(upload => {
            const rawStatus = upload.status
            const isDone =
              rawStatus === 'done' ||
              rawStatus === 'success' ||
              rawStatus === 'completed'
            const isFailed = rawStatus === 'failed' || rawStatus === 'error'
            const isDemo = upload.demo

            const badgeClass = isFailed
              ? 'badge badge-error'
              : isDone
              ? 'badge badge-success'
              : 'badge badge-warning'
            const statusLabel = isFailed ? '실패' : isDone ? '저장완료' : '수정중'

            const shellClass = isFailed
              ? 'card-shell card-shell-md upload-card-shell card-shell-error'
              : isDone
              ? 'card-shell card-shell-md upload-card-shell card-shell-success'
              : 'card-shell card-shell-md upload-card-shell card-shell-processing'

            const steps = upload.steps || {}
            const stepInfoList = STEP_DEFS.map(step => ({
              ...step,
              value:
                typeof steps[step.key] === 'number' ? steps[step.key] : 0,
            }))
            const allStepsDone =
              stepInfoList.length > 0 && stepInfoList.every(s => (s.value ?? 0) >= 100)
            const firstIncompleteStep = stepInfoList.find(s => (s.value ?? 0) < 100)

            // ✅ 이 업로드에 대해 AI 분석이 돌아가는 중인지
            const isAiRunningForThisUpload =
              aiRunningUploadId && aiRunningUploadId === upload.id

            // ✅ 단계별로 재치 있는 문구 표시
            const displayStepLabel = (() => {
              if (allStepsDone) return '모든 단계 완료'
              if (!firstIncompleteStep) return '대기 중'

              if (firstIncompleteStep.key === 'extract') {
                return '텍스트를 쭉쭉 뽑는 중...'
              }

              if (firstIncompleteStep.key === 'ai') {
                const aiValue = firstIncompleteStep.value ?? 0

                if (isAiRunningForThisUpload) {
                  if (aiValue < 30) return 'AI 준비 중...'
                  if (aiValue < 70) return '데이터가 꿈틀꿈틀 이동 중...'
                  if (aiValue < 100) return 'AI가 결과를 정리하는 중...'
                }
                return 'AI 자동 분석 대기 중'
              }

              if (firstIncompleteStep.key === 'save') {
                if (
                  detail.upload &&
                  detail.upload.id === upload.id &&
                  detail.saving
                ) {
                  return '데이터베이스에 저장 중...'
                }
                return '데이터베이스 저장 대기 중'
              }

              return `${firstIncompleteStep.label} 진행 중`
            })()

            const representativeLog =
              upload.latest_log_entry ||
              upload.representative_log ||
              (Array.isArray(upload.log_entries) ? upload.log_entries[0] : null)

            const activityDate =
              representativeLog?.log_date ||
              upload.activity_date ||
              upload.analysis?.date ||
              upload.uploaded_at

            const activityType =
              representativeLog?.activity_type ||
              (Array.isArray(representativeLog?.activity_tags) &&
                representativeLog.activity_tags[0]) ||
              upload.analysis?.activityType ||
              '-'

            const emotionSummary =
              representativeLog?.emotion_tag ||
              upload.analysis?.emotionSummary ||
              '감정 정보 없음'

            const summaryName =
              representativeLog?.activity_name || upload.analysis?.activityName || '대표 활동 없음'

            return (
              <div key={upload.id} className={shellClass}>
                <div className="upload-card-shell-header">
                  <div>
                    <p className="card-title-main">
                      {formatDate(upload.uploaded_at) || '업로드일 미상'} · 업로드ID{' '}
                      {upload.id ? String(upload.id).slice(0, 8) : '-'} · 사용자{' '}
                      {upload.uploader_name || '알 수 없음'}
                    </p>
                    <p className="card-subtitle">
                      {upload.file_name}
                      {upload.student_name && (
                        <>
                          <span className="meta-sep">·</span>
                          <span>대표 학생 {upload.student_name}</span>
                        </>
                      )}
                      {activityDate && (
                        <>
                          <span className="meta-sep">·</span>
                          <span>활동일 {formatDate(activityDate)}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="upload-card-shell-actions">
                    <span className={badgeClass}>{statusLabel}</span>
                    {isAiRunningForThisUpload ? (
                      // ✅ AI 분석 중일 때 버튼 대신 텍스트
                      <span className="muted" style={{ fontSize: 12 }}>
                        AI 분석 중
                      </span>
                    ) : (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => openDetail(upload)}
                        title="상세보기"
                      >
                        상세보기
                      </button>
                    )}
                  </div>
                </div>

                <div className="upload-card-summary-row">
                  <div className="upload-card-summary">
                    <p className="card-subtitle">대표 활동</p>
                    <p className="card-title-main">{summaryName}</p>
                    <p className="card-subtitle">
                      {activityType || '활동 유형 없음'} · {emotionSummary}
                    </p>
                  </div>
                  <div className="upload-card-progress-col">
                    <div className="upload-card-progress-text">
                      <h3 className="upload-card-progress-label">현재 단계</h3>
                      <div className="upload-card-progress-status">{displayStepLabel}</div>
                    </div>
                    <button
                      type="button"
                      className="btn ghost delete-upload-btn"
                      style={{ marginTop: 8 }}
                      onClick={() => handleDeleteUpload(upload.id)}
                    >
                      삭제
                    </button>
                  </div>
                </div>

                <div className="upload-card-meta-grid">
                  <div>
                    <p className="card-subtitle">활동일</p>
                    <p className="card-title-main">
                      {activityDate ? formatDate(activityDate) : '활동일 미정'}
                    </p>
                  </div>
                  <div>
                    <p className="card-subtitle">학생</p>
                    <p className="card-title-main">{upload.student_name}</p>
                  </div>
                  <div>
                    <p className="card-subtitle">활동 유형</p>
                    <p className="card-title-main">{activityType || '-'}</p>
                  </div>
                </div>

                {!isDemo && !isDone && stepInfoList.length > 0 && (
                  <div className="upload-card-steps">
                    {stepInfoList.map(step => (
                      <div key={step.key} className="step-row">
                        <div className="step-label">{step.label}</div>
                        <div className="step-progress-wrap">
                          <div className="progress step-progress">
                            <i
                              style={{
                                width: `${step.value}%`,
                              }}
                            />
                          </div>
                          <span className="step-percent">{step.value}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* 상세보기 모달 */}
      {detail.open && detail.upload && (
        <div 
            className="modal-backdrop" 
            role="dialog" 
            aria-modal="true"
            onClick={(e) => {
                // 배경 클릭 시 닫기 (단, 로딩/저장 중이면 무시)
                if (e.target === e.currentTarget) {
                    closeDetail()
                }
            }}
        >
          <div className="modal-card modal-card-wide detail-analysis-modal">
            <div className="detail-analysis-header">
              <div>
                <h3>상세 편집 및 AI 분석</h3>
                <p className="card-subtitle detail-analysis-meta">
                  {detail.upload.file_name} · 업로드 {formatDate(detail.upload.uploaded_at)} · ID #
                  {detail.upload.id}
                </p>
              </div>
              <div className="detail-header-actions">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={handleDownloadOriginal}
                  disabled={downloading}
                >
                  {downloading ? '다운로드 중...' : '텍스트 다운로드'}
                </button>
                <button type="button" className="btn ghost" onClick={closeDetail}>
                  닫기
                </button>
              </div>
            </div>

            {detail.error && (
              <div className="error" style={{ marginBottom: 8 }}>
                {detail.error}
              </div>
            )}

            {aiError && (
              <div className="error" style={{ marginBottom: 8 }}>
                {aiError}
              </div>
            )}

            <div
             className="student-tabs-row"
             style={{
               display: 'flex',
               justifyContent: 'space-between',
               alignItems: 'center',
               gap: 12,
               marginBottom: 8,
             }}
            >
            <div
               className="student-tabs"
               style={{
                 display: 'flex',
                 flexWrap: 'wrap',
                 gap: 8,
               }}
              > 
               {(detail.dates || []).map(dateStr => {
                 const isActive = dateStr === detail.activeDate
                 const baseClass = 'emotion-chip'
                 const activeClass = isActive
                   ? 'emotion-chip-selected'
                   : 'emotion-chip-unselected'

                 return (
                   <button
                     key={dateStr}
                     type="button"
                     className={`${baseClass} ${activeClass} date-tab`}
                     onClick={() => handleSelectDate(dateStr)}
                   >
                     <span className="emotion-chip-label">
                       {formatDate(dateStr)}
                     </span>
                   </button>
                 )
               })}
               {(!detail.dates || detail.dates.length === 0) && (
                 <span className="muted" style={{ fontSize: 12 }}>
                   날짜 정보가 없습니다.
                 </span>
               )}
             </div>
            </div>


            {/* Supabase 학생 선택 드롭다운 (버튼 바로 아래 위치) */}
            {studentPickerOpen && (
              <div
                className="student-picker-row"
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 12,
                }}
              >
              </div>
            )}

            {detail.loading ? (
              <div className="muted">불러오는 중입니다...</div>
            ) : (
              <>
                <div className="detail-layout detail-layout-modern">
                  <section className="detail-left">
                    <div className="detail-panel">
                      <div className="detail-panel-head">
                        <h4>원본 텍스트</h4>
                        <hr></hr>
                        <p className="card-subtitle">
                          AI 분석 결과를 바탕으로 정리된 텍스트입니다.
                        </p>
                      </div>
                      <br></br>
                      <textarea
                        className="detail-textarea"
                        value={getCurrentRawText(detail)}
                        onChange={e =>
                          setDetail(prev => {
                            const next = { ...prev, saved: false }
                            const dates = prev.dates || []
                            const activeDate = prev.activeDate
                            const rawByDate = { ...(prev.rawTextByDate || {}) }

                            if (dates.length > 0 && activeDate) {
                              // 날짜별 텍스트 편집
                              rawByDate[activeDate] = e.target.value
                              next.rawTextByDate = rawByDate

                              // 날짜가 하나만 있을 때는 editedText도 동기화
                              if (dates.length === 1) {
                                next.editedText = e.target.value
                              }
                            } else {
                              // 날짜 탭이 없으면 전체 텍스트만 사용
                              next.editedText = e.target.value
                            }

                            return next
                          })
                        }
                        placeholder="원본 텍스트를 편집하여 저장할 수 있습니다."
                      />
                      <p className="detail-helper-text"></p>
                    </div>
                  </section>

<section className="detail-right">
                    {(() => {
                      const { activeId, analysis: a, activityTypes } =
                        getActiveStudentState(detail)
                      const activeStudent =
                        (detail.students || []).find(s => s.id === activeId) || null

                      const studentsText =
                        activeStudent?.name || detail.upload.student_name

                      // 날짜 값 (없으면 업로드 날짜)
                      const dateValue = a.date
                        ? formatDate(a.date)
                        : formatDate(detail.upload.uploaded_at) || ''

                      // 시간 값 (기본값 0)
                      const { hours, minutes } = splitDuration(a.durationMinutes || 0)
                      const safeHours = Number.isNaN(hours) ? 0 : hours
                      const safeMinutes = Number.isNaN(minutes) ? 0 : minutes

                      return (
                        <div className="analysis-panel">
                          <div className="analysis-panel-header">
                            <h4>AI 분석 결과 (학생별 편집)</h4>
                            <p className="card-subtitle">
                              선택된 학생의 활동 정보, 특이사항, 감정을 수정합니다.
                            </p>
                          </div>

                          {/* 🔹 학생 탭 리스트 */}
                          <div className="student-tabs-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                             <div className="student-tabs" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                {(detail.students || []).map(stu => {
                                  const isActive = stu.id === detail.activeStudentId
                                  return (
                                    <button
                                      key={stu.id}
                                      type="button"
                                      className={`emotion-chip ${isActive ? 'emotion-chip-selected' : 'emotion-chip-unselected'} student-tab`}
                                      onClick={() => handleSelectStudent(stu.id)}
                                    >
                                      <span className="emotion-chip-label">{stu.name}</span>
                                      <span className="emotion-chip-icon" style={{ marginLeft: 4 }} onClick={e => { e.stopPropagation(); handleRemoveStudent(stu.id); }}>×</span>
                                    </button>
                                  )
                                })}
                                {(!detail.students || detail.students.length === 0) && (
                                   <span className="muted" style={{ fontSize: 12 }}>학생 없음</span>
                                )}
                             </div>
                             <button type="button" className="btn ghost small" onClick={handleAddStudent}>+ 학생 추가</button>
                          </div>
                          
                          {/* 🔹 학생 선택 드롭다운 (Supabase 연동) */}
                          {studentPickerOpen && (
                             <div className="student-picker-row" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
                               <select className="analysis-input" style={{ maxWidth: 260 }} value={studentPickerValue} onChange={e => setStudentPickerValue(e.target.value)}>
                                 <option value="">학생 선택</option>
                                 {studentsMaster.filter(stu => !(detail.students || []).some(s => String(s.id) === String(stu.id))).map(stu => (
                                   <option key={stu.id} value={stu.id}>{stu.name}</option>
                                 ))}
                               </select>
                               <button type="button" className="btn secondary small" onClick={handleAddStudentFromPicker}>추가</button>
                             </div>
                          )}

                          <div className="analysis-scroll-panel">
                            
                            {/* 1. 특이사항 (가장 중요하므로 최상단 배치) */}
                            <div className="analysis-section">
                              <div className="analysis-section-head">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <h5>특이사항 (Special Matters)</h5>
                                  {a.isAiGenerated && <span className="badge badge-warning">AI</span>}
                                </div>
                              </div>
                              
                              <div className="analysis-grid">
                                <label>내용</label>
                                <textarea
                                  className="analysis-input"
                                  style={{ minHeight: '80px', resize: 'vertical' }}
                                  value={a.note || ''}
                                  placeholder="활동에 대한 특이사항이나 교사 코멘트를 입력하세요."
                                  onChange={e => updateEditedAnalysis({ note: e.target.value })}
                                />

                                {/* 메타 정보: 활동명, 날짜, 시간 */}
                                <label>활동명</label>
                                <input
                                  type="text"
                                  className="analysis-input"
                                  value={a.activityName || ''}
                                  placeholder="예: 토마토 수확하기"
                                  onChange={e => updateEditedAnalysis({ activityName: e.target.value })}
                                />

                                <label>활동일/시간</label>
                                <div style={{ display: 'flex', gap: 8 }}>
                                  <input
                                    type="date"
                                    className="analysis-input"
                                    style={{ flex: 1 }}
                                    value={dateValue}
                                    onChange={e => updateEditedAnalysis({ date: e.target.value || null })}
                                  />
                                  <div className="time-input-group" style={{ flex: 1 }}>
                                    <input
                                      type="number" min="0"
                                      className="analysis-input time-input"
                                      value={safeHours}
                                      onChange={e => updateEditedAnalysis({ durationMinutes: Number(e.target.value) * 60 + safeMinutes })}
                                    />
                                    <span className="time-separator">시간</span>
                                    <input
                                      type="number" min="0" max="59"
                                      className="analysis-input time-input"
                                      value={safeMinutes}
                                      onChange={e => updateEditedAnalysis({ durationMinutes: safeHours * 60 + Number(e.target.value) })}
                                    />
                                    <span className="time-separator">분</span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* 2. 활동 유형 선택 */}
                            <div className="analysis-section">
                              <div className="analysis-section-head">
                                <div>
                                  <h5>활동 유형 및 감정 선택</h5>
                                  <p className="section-helper">
                                    유형을 선택하면 해당 활동의 감정 키워드가 함께 분석됩니다.
                                  </p>
                                </div>
                              </div>
                              <div className="activity-type-grid">
                                {Object.entries(activityTypes || {}).map(([key, item]) => (
                                  <div key={key} className={item.selected ? 'activity-type-card selected' : 'activity-type-card'}>
                                    <button type="button" className="activity-type-toggle" onClick={() => toggleActivityTypeSelection(key)}>
                                      <span className="activity-type-icon">{item.icon || '•'}</span>
                                      <span className="activity-type-label">{item.label}</span>
                                      <span className="activity-type-check">{item.selected ? '✓' : ''}</span>
                                    </button>
                                    {item.selected && (
                                      <div style={{ marginTop: 8 }}>
                                          <textarea
                                            className="activity-type-detail"
                                            value={item.detail || ''}
                                            placeholder={`${item.label} 관련 상세 내용`}
                                            onChange={e => updateActivityTypeDetail(key, e.target.value)}
                                          />
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* 3. 전체 감정 키워드 */}
                            <div className="analysis-section">
                               <div className="analysis-section-head">
                                 <h5>전체 감정 키워드</h5>
                               </div>
                               <EmotionKeywordSelector
                                 masterList={emotionKeywords}
                                 selected={a.emotionTags || []}
                                 onToggle={label => toggleEmotionTagInDetail(label)}
                                 onAddNew={label => addEmotionKeywordInSupabase(label)}
                               />
                            </div>

                          </div>
                        </div>
                      )
                    })()}
                  </section>
                </div>

                <div className="detail-modal-footer">
                  <button
                    className="btn"
                    onClick={handleSaveLogEntry}
                    disabled={detail.saving}
                  >
                    {detail.saving ? '저장 중...' : '데이터베이스 저장'}
                  </button>
                  {detail.saved && (
                    <span className="badge badge-success">저장 완료</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <ActivityTypeDetailModal
        modal={activityDetailModal}
        onClose={closeActivityTypeModal}
        studentName={detail.upload?.student_name || ''}
      />
    </Layout>
  )
}

// -------------------- 활동 유형 상세 모달 --------------------

function ActivityTypeDetailModal({ modal, onClose, studentName }) {
  if (!modal.open) return null

  const records = modal.records || []
  const summary = modal.summary || {}
  const totalActivities = summary.total || records.length
  const topActivity =
    summary.top_activity ||
    summary.topActivity ||
    records[0]?.activity_name ||
    '데이터 없음'
  const activityTypeCount =
    summary.activity_types ||
    summary.activityTypes ||
    new Set(records.map(r => r.activity_type)).size ||
    0

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card modal-card-wide activity-detail-modal">
        <div className="detail-analysis-header">
          <div>
            <h3>활동 유형 상세 집계</h3>
            <p className="card-subtitle detail-analysis-meta">
              {studentName || '학생'} 활동 데이터 집계 결과입니다.
            </p>
          </div>
          <div className="detail-header-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>

        {modal.loading ? (
          <div className="muted">상세 데이터를 불러오는 중입니다...</div>
        ) : modal.error ? (
          <div className="error">{modal.error}</div>
        ) : (
          <>
            <div className="activity-detail-table">
              <div className="activity-detail-table-head">
                <span>날짜</span>
                <span>활동명</span>
                <span>활동 유형</span>
                <span>비고</span>
              </div>
              {records.length === 0 ? (
                <div className="activity-detail-empty">
                  아직 집계된 활동이 없습니다.
                </div>
              ) : (
                records.map(item => (
                  <div
                    key={item.id || item.log_id}
                    className="activity-detail-row"
                  >
                    <span>{formatDate(item.log_date) || '-'}</span>
                    <span>{item.activity_name || '-'}</span>
                    <span>
                      <span className="activity-type-chip">
                        {item.activity_type || '미분류'}
                      </span>
                    </span>
                    <span>{item.note || item.memo || '-'}</span>
                  </div>
                ))
              )}
            </div>

            <div className="activity-summary-grid">
              <div className="activity-summary-card">
                <p className="card-subtitle">총 활동 횟수</p>
                <p className="card-title-main">{totalActivities}</p>
              </div>
              <div className="activity-summary-card">
                <p className="card-subtitle">가장 많은 활동</p>
                <p className="card-title-main">{topActivity}</p>
              </div>
              <div className="activity-summary-card">
                <p className="card-subtitle">활동 유형 수</p>
                <p className="card-title-main">{activityTypeCount}</p>
              </div>
            </div>

            <div className="activity-analysis-box">
              <h5>활동 분석</h5>
              <p>
                {modal.analysisText ||
                  `${studentName || '학생'}은 최근 활동 기간 동안 ${
                    totalActivities || 0
                  }회의 활동을 수행했으며, ${
                    activityTypeCount || 0
                  }가지 유형을 경험했습니다.`}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// -------------------- 감정 키워드 선택 컴포넌트 --------------------

function EmotionKeywordSelector({ masterList, selected, onToggle, onAddNew }) {
  const [inputValue, setInputValue] = React.useState('')
  const safeSelected = Array.isArray(selected) ? selected : []
  const safeMaster = Array.isArray(masterList) ? masterList : []

  const handleSubmit = e => {
    e.preventDefault()
    const value = inputValue.trim()
    if (!value) return

    const existing = safeMaster.find(
      item => (item.label || item.name) === value,
    )

    if (existing) {
      onToggle && onToggle(existing.label || existing.name)
    } else {
      onAddNew && onAddNew(value)
    }
    setInputValue('')
  }

  const suggestions =
    inputValue.trim().length === 0
      ? []
      : safeMaster.filter(item => {
          const label = (item.label || item.name || '').trim()
          if (!label) return false
          if (safeSelected.includes(label)) return false
          return label.includes(inputValue.trim())
        })

  return (
    <div>
      <div className="emotion-chips-row">
        {safeSelected.map(label => (
          <button
            key={label}
            type="button"
            className="emotion-chip emotion-chip-selected"
            onClick={() => onToggle && onToggle(label)}
          >
            <span className="emotion-chip-label">{label}</span>
            <span className="emotion-chip-icon">✓</span>
          </button>
        ))}
      </div>

      <form className="emotion-chip-add-row" onSubmit={handleSubmit}>
        <input
          type="text"
          className="analysis-input emotion-chip-input"
          placeholder="감정 키워드 입력 또는 검색"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
        />
        <button type="submit" className="btn ghost small">
          + 추가
        </button>
      </form>

      {suggestions.length > 0 && (
        <div className="emotion-chips-row" style={{ marginTop: 6 }}>
          {suggestions.map(item => {
            const label = (item.label || item.name || '').trim()
            if (!label) return null
            return (
              <button
                key={item.id || label}
                type="button"
                className="emotion-chip emotion-chip-unselected"
                onClick={() => onToggle && onToggle(label)}
              >
                <span className="emotion-chip-label">{label}</span>
                <span className="emotion-chip-icon">+</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
