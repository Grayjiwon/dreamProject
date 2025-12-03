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
 *       activity_tags: ["수확", "파종" ...] 또는 활동명 배열,
 *       log_content: "<공통 텍스트 또는 학생별 텍스트>",
 *       related_metrics: [
 *         {
 *           activities: [
 *             {
 *               activity_name: "...",
 *               activity_time: "45분",
 *               activity_emotion: ["즐거움", "집중"]
 *             }
 *           ],
 *           note: "...",
 *           duration_minutes: 90,
 *           level: "...",
 *           ability: {...} 또는 배열,
 *           score: 85,
 *           emotionTags: [...],
 *           emotionSummary: "...",
 *           isAiGenerated: true
 *         }
 *       ]
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
// 분석 오브젝트를 spec에 맞는 구조로 맞춰준다.
function normalizeAnalysis(raw = {}, entryRaw = {}) {
  const a = raw.analysis || {}
  const metricsRaw =
    entryRaw.related_metrics && Array.isArray(entryRaw.related_metrics)
      ? entryRaw.related_metrics[0] || {}
      : entryRaw.related_metrics || {}

  // 활동 배열 정규화
  const rawActivities = Array.isArray(metricsRaw.activities)
    ? metricsRaw.activities
    : []

  const activities = rawActivities.map(act => {
    const emotionArr = normalizeEmotionTags(
      act.activity_emotion || act.emotions || act.emotionTags,
    )
    return {
      activity_name:
        act.activity_name || act.name || act.activity || act.title || '',
      activity_time:
        act.activity_time ??
        act.minutes ??
        act.duration ??
        act.time ??
        null,
      activity_emotion: emotionArr,
      // 기타 필드는 그대로 유지
      ...act,
    }
  })

  const emotionTags =
    normalizeEmotionTags(
      metricsRaw.emotionTags ||
        metricsRaw.emotion_tags ||
        entryRaw.emotion_tags,
    ) || a.emotionTags || []

  const emotionSummary =
    metricsRaw.emotionSummary ||
    entryRaw.emotion_tag ||
    a.emotionSummary ||
    (emotionTags[0] || '')

  const durationMinutes =
    metricsRaw.duration_minutes ??
    metricsRaw.durationMinutes ??
    a.durationMinutes ??
    null

  const level =
    metricsRaw.level ??
    a.level ??
    ''

  const ability =
    metricsRaw.ability ??
    a.ability ??
    null

  const score =
    typeof metricsRaw.score === 'number'
      ? metricsRaw.score
      : typeof a.score === 'number'
      ? a.score
      : null

  return {
    // 공통 메타
    isAiGenerated: !!(a.isAiGenerated || metricsRaw.isAiGenerated),
    date: entryRaw.log_date || a.date || null,

    // 핵심 구조
    activities,
    note: metricsRaw.note || a.note || '',

    emotionTags,
    emotionSummary,

    durationMinutes,
    level,
    ability,
    score,

    // 기존 필드도 유지
    ...a,
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
  const processingStage = raw.processing_stage || raw.stage || null
  const isSuccess =
    status === 'success' ||
    status === 'completed' ||
    status === 'done' ||
    processingStage === 'saved'

  let progress =
    typeof raw.progress === 'number' ? raw.progress : raw.overall_progress
  if (isSuccess) progress = 100

  let steps = raw.steps
  if (!steps) {
    steps = {
      upload: 0,
      extract: 0,
      ai: 0,
      save: 0,
    }
  } else if (typeof progress === 'number') {
      // progress 값만 있는 경우 대략적 매핑
      steps.extract = progress >= 20 ? 100 : progress
      steps.ai = progress >= 60 ? 100 : progress >= 30 ? 50 : 0
      steps.save = progress >= 90 ? 100 : 0
  }

  // ingest_uploads.progress/status만 보고 AI 완료로 간주하는 표시
  const aiDone =
    isSuccess ||
    processingStage === 'saved' ||
    (typeof progress === 'number' && progress >= 90)
  if (aiDone) {
    steps.ai = steps.ai && steps.ai > 0 ? steps.ai : 100
  }

  const overall = computeOverallFromSteps(steps, progress)

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

// 경량 시간 파서: "45분" 또는 "10:00-10:30" → 분 단위 숫자
function estimateMinutesFromTimeText(text) {
  if (!text) return 0
  const s = String(text)
  const m1 = s.match(/(\d+)\s*분/)
  if (m1) {
    const v = parseInt(m1[1], 10)
    return Number.isNaN(v) ? 0 : v
  }
  const m2 = s.match(/(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})/)
  if (m2) {
    const h1 = parseInt(m2[1], 10)
    const mi1 = parseInt(m2[2], 10)
    const h2 = parseInt(m2[3], 10)
    const mi2 = parseInt(m2[4], 10)
    const start = h1 * 60 + mi1
    const end = h2 * 60 + mi2
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
      return end - start
    }
  }
  return 0
}

// 활동 유형 상태 객체 생성
function buildActivityTypeState(rawTypes = null, rawDetails = null) {
  const base = {}
  Object.entries(ACTIVITY_TYPE_PRESETS).forEach(([key, config]) => {
    let selected = false
    let detail = ''
    let emotionTags = []

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
      emotionTags,
    }
  })

  return base
}

// 상세 상태 기본값
function createDetailState(overrides = {}) {
  return {
    open: false,
    loading: false,
    upload: null,
    error: '',
    saving: false,
    saved: false,

    // 날짜 및 텍스트
    dates: [],
    activeDate: null,
    rawTextByDate: {},

    // 날짜별/학생별 전체 분석 캐시: { [date]: { [studentId]: { analysis, activityTypes } } }
    recordMap: {},

    // 현재 activeDate 기준 UI에 바인딩되는 데이터
    students: [],
    activeStudentId: null,
    analysisByStudent: {},

    editedText: '',

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

  const fallback = {
    analysis: {
      date: detail.activeDate || null,
      activities: [],
      note: '',
      emotionTags: [],
      emotionSummary: '',
      durationMinutes: null,
      level: '',
      ability: null,
      score: null,
    },
    activityTypes: buildActivityTypeState(),
  }

  const current = map[activeId] || fallback

  const safeAnalysis = {
    date: current.analysis?.date ?? detail.activeDate ?? null,
    activities: Array.isArray(current.analysis?.activities)
      ? current.analysis.activities
      : [],
    note: current.analysis?.note || '',
    emotionTags: current.analysis?.emotionTags || [],
    emotionSummary: current.analysis?.emotionSummary || '',
    durationMinutes:
      typeof current.analysis?.durationMinutes === 'number'
        ? current.analysis.durationMinutes
        : null,
    level: current.analysis?.level ?? '',
    ability: current.analysis?.ability ?? null,
    score:
      typeof current.analysis?.score === 'number'
        ? current.analysis.score
        : null,
    isAiGenerated: !!current.analysis?.isAiGenerated,
    ...current.analysis,
  }

  return {
    activeId,
    analysis: safeAnalysis,
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

  if (!dates.length || !activeDate) {
    return baseRaw
  }

  if (dates.length === 1) {
    return rawByDate[activeDate] || baseRaw
  }

  return rawByDate[activeDate] || baseRaw
}

// -------------------- 페이지 컴포넌트 --------------------

// 현재 활성 학생의 활동 유형 탭 선택 변경
function setActiveActivityTypeKey(detail, studentId, key, setDetail) {
  setDetail(prev => {
    const map = { ...(prev.analysisByStudent || {}) }
    const current = { ...(map[studentId] || {}) }
    current.activeActivityTypeKey = key
    map[studentId] = current
    return { ...prev, analysisByStudent: map }
  })
}

function summarizeActivitiesText(activities) {
  const lines = []
  activities.forEach(act => {
    const name = act.activity_name || '활동'
    const time = act.activity_time ? ` (${act.activity_time})` : ''
    const emo = Array.isArray(act.activity_emotion)
      ? act.activity_emotion.join(', ')
      : act.activity_emotion || ''
    const emoPart = emo ? ` · 감정: ${emo}` : ''
    lines.push(`- ${name}${time}${emoPart}`)
  })
  return lines.join('\n')
}

export default function UploadPage() {
  const fileRef = useRef(null)

  const [uploads, setUploads] = useState(() => uploadsCache || [])
  const [loading, setLoading] = useState(() => !uploadsCache)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [aiFailureBanner, setAiFailureBanner] = useState('')

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

  // Gemini AI 관련 상태 (재분석 용도로만 사용)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiRunningUploadId, setAiRunningUploadId] = useState(null)

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
      // 분석 실패 감지하여 배너 표시
      const failures = items.filter(u => String(u.status).toLowerCase() === 'error' && u.error)
      if (failures.length > 0) {
        const latest = failures[0]
        setAiFailureBanner(
          `AI 분석 실패: ${latest.file_name || '업로드'} — ${latest.error}`,
        )
      } else {
        setAiFailureBanner('')
      }
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
      const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
        ? data
        : []
      const mapped = items
        .map(stu => {
          const name =
            stu.name || stu.real_name || stu.nickname || '이름 없는 학생'
          const alias = stu.alias || null
          const label = alias ? `${name}(${alias})` : name
          return {
            id: String(stu.id),
            name,
            alias,
            label,
          }
        })
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

    // 업로드 목록 폴링(5초 간격)
    const timer = setInterval(() => {
      fetchUploads().catch(() => {/* ignore */})
    }, 5000)

    return () => {
      clearInterval(timer)
    }
  }, [])

  // ---------- 파일 업로드 (병렬 처리 & 즉시 갱신 개선) ----------

  async function handleFiles(files) {
    const list = Array.from(files || [])
    if (list.length === 0) return

    setUploading(true)
    setError('')

    const uploadPromises = list.map(async file => {
      const form = new FormData()
      form.append('file', file)

      try {
        const rawUser = localStorage.getItem('user')
        if (rawUser) {
          const parsed = JSON.parse(rawUser)
          if (parsed?.id) form.append('uploaded_by', String(parsed.id))
        }
      } catch {
        /* ignore */
      }

      try {
        await apiFetch('/uploads', {
          method: 'POST',
          body: form,
          _formName: file.name,
        })

        await fetchUploads()
      } catch (e) {
        console.error(`파일 업로드 실패 (${file.name}):`, e)
      }
    })

    try {
      setLoading(true)
      await Promise.all(uploadPromises)

      const all = uploadsCache || []
      if (all.length > 0) {
        const sorted = [...all].sort((a, b) => {
          const ad = new Date(a.uploaded_at || a.created_at || 0).getTime()
          const bd = new Date(b.uploaded_at || b.created_at || 0).getTime()
          return bd - ad
        })
        const newest = sorted[0]
        // 필요하면 여기서 자동 상세보기 openDetail(newest)
        if (newest) {
          // 선택 사항: 자동 상세보기는 지금은 사용하지 않음
        }
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
    // draft가 있으면 그대로 복원
    if (detailDrafts[upload.id]) {
      setDetail({ ...detailDrafts[upload.id], open: true })
      return
    }

    const hydratedFromList = hydrateUpload(upload)

    setDetail(
      createDetailState({
        open: true,
        loading: true,
        upload: hydratedFromList,
      }),
    )

    try {
      const res = await apiFetch(`/uploads/${upload.id}`)
      const logs = res.log_entries || []
      const serverStudents = res.students || []
      const baseRawText =
        res.raw_text ||
        hydratedFromList.raw_text ||
        hydratedFromList.analysis?.rawTextCleaned ||
        ''

      const datesSet = new Set()
      const rawTextByDate = {}
      const recordMap = {}

      logs.forEach(entry => {
        const d = entry.log_date
        if (!d) return
        datesSet.add(d)

        // 날짜별 원본 텍스트 concat
        if (entry.log_content) {
          if (!rawTextByDate[d]) {
            rawTextByDate[d] = entry.log_content
          } else {
            rawTextByDate[d] = `${rawTextByDate[d]}\n\n${entry.log_content}`
          }
        }

        if (!recordMap[d]) recordMap[d] = {}

        const sid = entry.student_id
        const normalized = normalizeAnalysis({}, entry)

        // 활동 유형 → activityTypes (기존 UI 유지용)
        const types = buildActivityTypeState()
        ;(entry.activity_tags || []).forEach(t => {
          const key = Object.keys(ACTIVITY_TYPE_PRESETS).find(
            k => ACTIVITY_TYPE_PRESETS[k].label === t,
          )
          if (key) types[key].selected = true
        })

        const prevForStudent = recordMap[d][sid]
        if (!prevForStudent) {
          recordMap[d][sid] = {
            analysis: normalized,
            activityTypes: types,
          }
        } else {
          // 같은 날짜/학생에 여러 로그가 있으면 머지
          const prevA = prevForStudent.analysis || {}
          const mergedActivities = [
            ...(Array.isArray(prevA.activities) ? prevA.activities : []),
            ...(Array.isArray(normalized.activities)
              ? normalized.activities
              : []),
          ]
          const mergedNote = [prevA.note, normalized.note]
            .filter(Boolean)
            .join('\n')

          const mergedEmotionTags = Array.from(
            new Set([
              ...(prevA.emotionTags || []),
              ...(normalized.emotionTags || []),
            ]),
          )

          const mergedEmotionSummary =
            normalized.emotionSummary ||
            prevA.emotionSummary ||
            mergedEmotionTags[0] ||
            ''

          const mergedDuration =
            (prevA.durationMinutes || 0) + (normalized.durationMinutes || 0)

          const mergedLevel = normalized.level || prevA.level || ''
          const mergedAbility = normalized.ability || prevA.ability || null
          const mergedScore =
            typeof normalized.score === 'number'
              ? normalized.score
              : prevA.score

          recordMap[d][sid] = {
            analysis: {
              ...prevA,
              ...normalized,
              activities: mergedActivities,
              note: mergedNote,
              emotionTags: mergedEmotionTags,
              emotionSummary: mergedEmotionSummary,
              durationMinutes: mergedDuration,
              level: mergedLevel,
              ability: mergedAbility,
              score: mergedScore,
            },
            activityTypes: prevForStudent.activityTypes || types,
          }
        }
      })

      let dates = Array.from(datesSet).sort()

      // 로그에 날짜가 전혀 없으면 raw_text에서 추출
      if (dates.length === 0 && baseRawText) {
        const textDates = parseDatesFromText(baseRawText)
        dates = textDates.length > 0 ? textDates : []
      }

      const activeDate = dates[0] || new Date().toISOString().slice(0, 10)

      // 날짜별 텍스트가 하나도 없으면 raw_text fallback
      if (!rawTextByDate[activeDate] && baseRawText) {
        rawTextByDate[activeDate] = baseRawText
      }

      // 학생 리스트 (동명이인 구분 label 적용)
      const students = serverStudents.map(s => {
        const name = s.name
        const alias = s.alias || null
        const label = s.label || (alias ? `${name}(${alias})` : name)
        return {
          id: s.id,
          name,
          alias,
          label,
        }
      })

      // 해당 날짜 기준 초기 분석 상태
      const initialAnalysisByStudent = { ...(recordMap[activeDate] || {}) }

      // 날짜에 로그는 없지만 학생은 있는 경우, 빈 분석 상태 생성
      students.forEach(s => {
        if (!initialAnalysisByStudent[s.id]) {
          initialAnalysisByStudent[s.id] = {
            analysis: {
              date: activeDate,
              activities: [],
              note: '',
              emotionTags: [],
              emotionSummary: '',
              durationMinutes: null,
              level: '',
              ability: null,
              score: null,
            },
            activityTypes: buildActivityTypeState(),
          }
        }
      })

      setDetail(
        createDetailState({
          open: true,
          loading: false,
          upload: {
            ...hydratedFromList,
            ...res,
          },
          dates,
          activeDate,
          rawTextByDate,
          recordMap,
          students,
          activeStudentId: students[0]?.id || null,
          analysisByStudent: initialAnalysisByStudent,
        }),
      )

      // 날짜별 rawText가 준비되었으므로 extract 단계는 100으로 고정
      if (upload.id) {
        updateUploadSteps(upload.id, prev => ({
          ...prev,
          extract: 100,
        }))
      }

      // 이미 로그가 존재하면 AI/저장도 완료로 표시 (뷰 관점)
      if (logs.length > 0 && upload.id) {
        updateUploadSteps(upload.id, prev => ({
          ...prev,
          ai: prev.ai && prev.ai > 0 ? prev.ai : 100,
          save: prev.save && prev.save > 0 ? prev.save : 100,
        }))
      }
    } catch (e) {
      console.error('상세 조회 실패:', e)

      const hydrated = hydrateUpload(upload)
      const rawText = hydrated.raw_text || ''

      const textDates = parseDatesFromText(rawText)
      const dates = textDates.length > 0 ? textDates : []
      const activeDate = dates[0] || new Date().toISOString().slice(0, 10)

      const rawTextByDate = {}
      if (dates.length > 0) {
        dates.forEach(d => {
          rawTextByDate[d] = rawText
        })
      } else {
        rawTextByDate[activeDate] = rawText
      }

      const recordMap = {
        [activeDate]: {},
      }

      setDetail(
        createDetailState({
          open: true,
          loading: false,
          upload: hydrated,
          error:
            '상세 정보를 불러오지 못했습니다. 텍스트 편집만 가능합니다.',
          dates,
          activeDate,
          rawTextByDate,
          recordMap,
          students: [],
          activeStudentId: null,
          analysisByStudent: {},
        }),
      )

      // 텍스트만 있어도 추출은 완료된 것으로 본다
      if (upload.id) {
        updateUploadSteps(upload.id, prev => ({
          ...prev,
          extract: 100,
        }))
      }
    }
  }

  function closeDetail() {
    if (detail.saving || aiLoading) {
      const proceed = window.confirm(
        '현재 작업(AI 분석 또는 저장)이 진행 중입니다. 창을 닫으면 작업이 중단되거나 데이터가 저장되지 않을 수 있습니다. 정말 닫으시겠습니까?',
      )
      if (!proceed) return
    }

    setAiError('')
    setStudentPickerOpen(false)
    setStudentPickerValue('')

    // draft 캐시에 현재 상태 보관
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
        analysis: {
          date: prev.activeDate || null,
          activities: [],
          note: '',
          emotionTags: [],
          emotionSummary: '',
          durationMinutes: null,
          level: '',
          ability: null,
          score: null,
        },
        activityTypes: buildActivityTypeState(),
      }

      if (prev.activeStudentId && map[prev.activeStudentId]) {
        const from = map[prev.activeStudentId]
        baseState = {
          analysis: { ...(from.analysis || {}) },
          activityTypes: { ...(from.activityTypes || {}) },
        }
      }

      const newStudent = {
        id,
        name: trimmed,
        alias: null,
        label: trimmed,
      }

      return {
        ...prev,
        students: [...(prev.students || []), newStudent],
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
        analysis: {
          date: prev.activeDate || null,
          activities: [],
          note: '',
          emotionTags: [],
          emotionSummary: '',
          durationMinutes: null,
          level: '',
          ability: null,
          score: null,
        },
        activityTypes: buildActivityTypeState(),
      }

      if (prev.activeStudentId && map[prev.activeStudentId]) {
        const from = map[prev.activeStudentId]
        baseState = {
          analysis: { ...(from.analysis || {}) },
          activityTypes: { ...(from.activityTypes || {}) },
        }
      }

      const newStudent = {
        id: String(master.id),
        name: master.name,
        alias: master.alias || null,
        label: master.label || (master.alias ? `${master.name}(${master.alias})` : master.name),
      }

      const nextStudents = existing
        ? prev.students
        : [...(prev.students || []), newStudent]

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
    const target = detail.students.find(s => s.id === studentId)
    const nameLabel = target ? target.label || target.name : '학생'
    if (
      !window.confirm(
        `'${nameLabel}' 학생의 분석 데이터를 삭제하시겠습니까?`,
      )
    ) {
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

  // 날짜 탭 변경 시: 현재 날짜 데이터는 recordMap에 저장하고, 새 날짜 데이터로 swap
  function handleSelectDate(newDate) {
    setDetail(prev => {
      const prevDate = prev.activeDate
      const currentAnalysisByStudent = prev.analysisByStudent || {}
      const updatedRecordMap = { ...(prev.recordMap || {}) }

      if (prevDate) {
        updatedRecordMap[prevDate] = currentAnalysisByStudent
      }

      const nextAnalysisByStudent = { ...(updatedRecordMap[newDate] || {}) }

      ;(prev.students || []).forEach(s => {
        if (!nextAnalysisByStudent[s.id]) {
          nextAnalysisByStudent[s.id] = {
            analysis: {
              date: newDate,
              activities: [],
              note: '',
              emotionTags: [],
              emotionSummary: '',
              durationMinutes: null,
              level: '',
              ability: null,
              score: null,
            },
            activityTypes: buildActivityTypeState(),
          }
        }
      })

      return {
        ...prev,
        recordMap: updatedRecordMap,
        activeDate: newDate,
        analysisByStudent: nextAnalysisByStudent,
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
          analysis: {
            date: prev.activeDate || null,
            activities: [],
            note: '',
            emotionTags: [],
            emotionSummary: '',
            durationMinutes: null,
            level: '',
            ability: null,
            score: null,
          },
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

  function toggleActivityTypeEmotionTag(key, label) {
    const trimmed = String(label || '').trim()
    if (!trimmed) return
    updateActiveStudent(current => {
      const types = { ...(current.activityTypes || {}) }
      const item = types[key] || { ...(ACTIVITY_TYPE_PRESETS[key] || { label: key }) }
      const currentTags = Array.isArray(item.emotionTags) ? item.emotionTags : []
      const exists = currentTags.includes(trimmed)
      const nextTags = exists
        ? currentTags.filter(v => v !== trimmed)
        : [...currentTags, trimmed]
      types[key] = { ...item, emotionTags: nextTags }
      return { ...current, activityTypes: types }
    })
  }

  async function addEmotionKeywordForType(key, label) {
    const trimmed = String(label || '').trim()
    if (!trimmed) return
    const exists = emotionKeywords.find(item => item.label === trimmed)
    if (exists) {
      toggleActivityTypeEmotionTag(key, trimmed)
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
      toggleActivityTypeEmotionTag(key, newItem.label)
    } catch (e) {
      console.error(e)
      const fallbackItem = { id: trimmed, label: trimmed }
      setEmotionKeywords(prev => [...prev, fallbackItem])
      toggleActivityTypeEmotionTag(key, trimmed)
    }
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

  // 활동 배열 전체 교체
  function updateActivitiesForActiveStudent(newActivities) {
    const safe =
      Array.isArray(newActivities) && newActivities.length > 0
        ? newActivities
        : []
    updateEditedAnalysis({ activities: safe })
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
  // 이 컴포넌트에서는 기본 흐름에서 자동 호출하지 않는다. (재분석 용도)

  function applyAiExtraction(records) {
    if (!Array.isArray(records)) return

    setDetail(prev => {
      const prevStudents = prev.students || []
      const prevAnalysisByStudent = prev.analysisByStudent || {}
      const studentsByName = new Map(
        prevStudents.map(stu => [stu.label || stu.name, stu]),
      )

      const nextStudents = [...prevStudents]
      const nextAnalysisByStudent = { ...prevAnalysisByStudent }

      const foundDates = new Set(prev.dates || [])

      records.forEach((rec, idx) => {
        if (!rec) return

        const dateValue =
          rec.date || prev.activeDate || new Date().toISOString().slice(0, 10)
        if (dateValue) {
          foundDates.add(dateValue)
        }

        const baseName =
          (rec.student_name && String(rec.student_name).trim()) ||
          `학생 ${idx + 1}`
        const studentLabel = baseName
        let student = studentsByName.get(studentLabel)
        if (!student) {
          student = {
            id: `ai-${Date.now()}-${idx + 1}`,
            name: baseName,
            alias: null,
            label: baseName,
          }
          studentsByName.set(studentLabel, student)
          nextStudents.push(student)
        }

        const prevState =
          nextAnalysisByStudent[student.id] || {
            analysis: {},
            activityTypes: buildActivityTypeState(),
          }

        // rec.activities 기반으로 활동 목록 구성 (신규 스키마)
        const rawActivities = Array.isArray(rec.activities)
          ? rec.activities
          : []
        const activities = rawActivities.map((a, aIdx) => ({
          activity_name:
            a.activity_name || a.name || a.activity || `활동 ${aIdx + 1}`,
          activity_time:
            a.activity_time ?? a.minutes ?? a.duration ?? null,
          activity_emotion: normalizeEmotionTags(
            a.activity_emotion || a.emotions || a.emotionTags,
          ),
          ...a,
        }))

        const emotionItems = Array.isArray(rec.emotions)
          ? rec.emotions
          : Array.isArray(rec.emotion_tags)
          ? rec.emotion_tags
          : []

        const emotionTags = emotionItems
          .map(e => {
            if (typeof e === 'string') return e
            return e?.label || e?.name || e?.tag || ''
          })
          .filter(Boolean)

        const mainEmotion = emotionTags[0] || ''

        let activityTypes = prevState.activityTypes || buildActivityTypeState()
        if (rec.activity_type) {
          const key = Object.keys(ACTIVITY_TYPE_PRESETS).find(
            k =>
              ACTIVITY_TYPE_PRESETS[k].label === rec.activity_type ||
              rec.activity_type.includes(ACTIVITY_TYPE_PRESETS[k].label),
          )
          if (key) {
            activityTypes = {
              ...activityTypes,
              [key]: {
                ...ACTIVITY_TYPE_PRESETS[key],
                selected: true,
                detail: rec.teacher_notes || rec.raw_activity_text || '',
              },
            }
          }
        }

        const minutes =
          (typeof rec.minutes === 'number' ? rec.minutes : null) ??
          (typeof rec.duration_minutes === 'number'
            ? rec.duration_minutes
            : null) ??
          (rec.ability_analysis &&
          typeof rec.ability_analysis.total_minutes === 'number'
            ? rec.ability_analysis.total_minutes
            : 0)

        const noteText =
          rec.teacher_comment ||
          rec.teacher_notes ||
          rec.raw_activity_text ||
          prevState.analysis?.note ||
          ''

        nextAnalysisByStudent[student.id] = {
          analysis: {
            ...(prevState.analysis || {}),
            isAiGenerated: true,
            studentName: baseName,
            date: dateValue,
            activities,
            durationMinutes: minutes,
            note: noteText,
            emotionSummary: mainEmotion,
            emotionTags,
          },
          activityTypes,
        }
      })

      const sortedDates = Array.from(foundDates).sort()
      let nextActiveDate = prev.activeDate
      if (!nextActiveDate && sortedDates.length > 0) {
        nextActiveDate = sortedDates[0]
      }

      let nextActiveStudentId = prev.activeStudentId
      const hasPrevActive =
        nextActiveStudentId &&
        nextStudents.some(stu => stu.id === nextActiveStudentId)
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

  // 수동 재분석용 (기본 흐름에서는 호출하지 않음)
  async function handleRunAiExtraction() {
    if (!detail.upload || aiLoading) return

    const sourceText = getCurrentRawText(detail)
    if (!sourceText) {
      alert(
        '분석할 텍스트가 없습니다. 먼저 업로드 텍스트를 불러오거나 작성해 주세요.',
      )
      return
    }

    const currentUploadId = detail.upload.id

    try {
      setAiLoading(true)
      setAiError('')
      setAiRunningUploadId(currentUploadId)

      if (currentUploadId) {
        updateUploadSteps(currentUploadId, prev => ({
          ...prev,
          ai: Math.max(prev.ai || 0, 20),
        }))
      }

      if (currentUploadId) {
        updateUploadSteps(currentUploadId, prev => ({
          ...prev,
          ai: Math.max(prev.ai || 0, 40),
        }))
      }

      const res = await extractRecordsWithGemini({
        raw_text: sourceText,
        file_name: detail.upload.file_name,
      })

      if (currentUploadId) {
        updateUploadSteps(currentUploadId, prev => ({
          ...prev,
          ai: Math.max(prev.ai || 0, 70),
        }))
      }

      const records = res?.parsed?.records || res?.records || []

      if (!Array.isArray(records) || records.length === 0) {
        console.warn('AI 분석 결과가 비어 있습니다.')
      } else {
        applyAiExtraction(records)

        if (currentUploadId) {
          updateUploadSteps(currentUploadId, prevSteps => ({
            ...prevSteps,
            ai: 100,
          }))
        }
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
      const data = await apiFetch(
        `/activity_types?upload_id=${detail.upload.id}`,
      )
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

    // 1) 현재 화면에 보이는 날짜/학생 분석 상태를 한 번 더 합쳐서 recordMap으로 만듦
    const currentRecordMap = { ...(detail.recordMap || {}) }
    if (detail.activeDate) {
      currentRecordMap[detail.activeDate] = detail.analysisByStudent || {}
    }

    // 2) 업로드 전체 raw 텍스트(편집본 > 원본 > AI 정제본 순서로 사용)
    const logEntries = []
    const baseRaw =
      (detail.editedText && detail.editedText.trim()) ||
      detail.upload.raw_text ||
      detail.upload.analysis?.rawTextCleaned ||
      ''

    // 3) 날짜별 / 학생별로 log_entries 배열 구성
    Object.entries(currentRecordMap).forEach(([dateKey, studentMap]) => {
      Object.entries(studentMap || {}).forEach(([studentId, data]) => {
        const { analysis, activityTypes } = data || {}

        // 학생 정보 찾기
        const student = (detail.students || []).find(
          s => String(s.id) === String(studentId),
        )
        if (!student) return

        // AI 임시 ID(ai- / local-)인 경우 실제 student_id는 서버에서 이름으로 매핑
        let finalStudentId = studentId
        if (
          String(studentId).startsWith('ai-') ||
          String(studentId).startsWith('local-')
        ) {
          finalStudentId = null
        }

        // 날짜 문자열 정리 (YYYY-MM-DD)
        const logDate = dateKey

        // 감정 요약 (예: ["즐거움","집중"] → "즐거움, 집중")
        const emotionSummary = Array.isArray(analysis?.emotions)
          ? analysis.emotions.join(', ')
          : analysis?.emotion || null

        const emotionTags = Array.isArray(analysis?.emotions)
          ? analysis.emotions
          : analysis?.emotion
          ? [analysis.emotion]
          : []

        // 활동 태그 (AI가 분석한 활동 유형들)
        const activityTags = Array.isArray(activityTypes)
          ? activityTypes.filter(Boolean)
          : []

        // 지표(시간, 참여도 등) – 일단 하나의 metrics 객체를 배열로 감싸서 보냄
        const metrics = {
          focus_level: analysis?.focusLevel ?? null,
          participation_level: analysis?.participationLevel ?? null,
          energy_level: analysis?.energyLevel ?? null,
        }

        logEntries.push({
          // 서버에서 student_id가 있으면 바로 사용, 없으면 student_name으로 매칭
          student_id: finalStudentId,
          student_name: student.label || student.name,
          log_date: logDate,
          emotion_tag: emotionSummary,
          emotion_tags: emotionTags,
          activity_tags: activityTags,
          log_content:
            detail.rawTextByDate?.[dateKey] ||
            detail.rawTextByDate?.[logDate] ||
            baseRaw ||
            '',
          related_metrics: [metrics], // DB의 related_metrics ARRAY 컬럼과 매칭
        })
      })
    })

    if (logEntries.length === 0) {
      alert('저장할 데이터가 없습니다.')
      return
    }

    try {
      setDetail(prev => ({ ...prev, saving: true }))

      // ❗️여기에서 더 이상 JSON.stringify 하지 않는다
      await apiFetch(`/uploads/${detail.upload.id}/log`, {
        method: 'POST',
          body: {
          file_name: detail.upload.file_name,
          raw_text:
           (detail.editedText && detail.editedText.trim()) ||
           detail.upload.raw_text,
         log_entries: logEntries,
        },
      })

      setDetail(prev => ({
        ...prev,
        saving: false,
        recordMap: currentRecordMap,
      }))
      delete detailDrafts[detail.upload.id]

      // save 단계 100%
      if (detail.upload.id) {
        updateUploadSteps(detail.upload.id, prev => ({
          ...prev,
          save: 100,
        }))
      }

      fetchUploads()
      alert('모든 날짜와 학생의 기록이 데이터베이스에 저장되었습니다.')
    } catch (e) {
      console.error(e)
      setDetail(prev => ({ ...prev, saving: false }))
      alert('저장 중 오류가 발생했습니다.')
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

        {aiFailureBanner && (
          <div className="error" style={{ marginTop: 8 }}>
            {aiFailureBanner}
            <button
              type="button"
              className="btn ghost small"
              style={{ marginLeft: 8 }}
              onClick={() => setAiFailureBanner('')}
            >
              닫기
            </button>
          </div>
        )}

        {false}
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
              stepInfoList.length > 0 &&
              stepInfoList.every(s => (s.value ?? 0) >= 100)
            const firstIncompleteStep = stepInfoList.find(
              s => (s.value ?? 0) < 100,
            )

            const isAiRunningForThisUpload =
              aiRunningUploadId && aiRunningUploadId === upload.id

            const displayStepLabel = (() => {
              if (allStepsDone) return '모든 단계 완료'
              if (!firstIncompleteStep) return '대기 중'

              if (firstIncompleteStep.key === 'extract') {
                return '텍스트가 꿈틀꿈틀 이동중'
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
              (Array.isArray(upload.log_entries)
                ? upload.log_entries[0]
                : null)

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
              representativeLog?.activity_name ||
              upload.analysis?.activityName ||
              '대표 활동 없음'

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
                    {(() => {
                      const isAnalyzing = isAiRunningForThisUpload || (!isDone && !isFailed && (statusLabel === '수정중' || rawStatus === 'queued' || rawStatus === 'processing'))
                      return (
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => !isAnalyzing && openDetail(upload)}
                          title={isAnalyzing ? 'AI 분석 중' : '상세보기'}
                          disabled={isAnalyzing}
                        >
                          {isAnalyzing ? 'AI 분석 중' : '상세보기'}
                        </button>
                      )
                    })()}
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
                      <div className="upload-card-progress-status">
                        {displayStepLabel}
                      </div>
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
                      {activityDate
                        ? formatDate(activityDate)
                        : '활동일 미정'}
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
                          <span className="step-percent">
                            {step.value}%
                          </span>
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
          onClick={e => {
            if (e.target === e.currentTarget) {
              closeDetail()
            }
          }}
        >
          <div className="modal-card modal-card-wide detail-analysis-modal">
            <div className="detail-analysis-header">
              <div>
                <h3>상세 편집</h3>
                <p className="card-subtitle detail-analysis-meta">
                  {detail.upload.file_name} · 업로드{' '}
                  {formatDate(detail.upload.uploaded_at)} · ID #
                  {detail.upload.id}
                </p>
              </div>
              <div className="detail-header-actions">
                {/* 재분석 버튼은 숨김 또는 고급 설정에서만 사용 가능하도록 남겨둔다 */}
                {/* <button
                  type="button"
                  className="btn ghost"
                  onClick={handleRunAiExtraction}
                  disabled={aiLoading}
                >
                  {aiLoading ? 'AI 분석 중...' : 'AI 재분석'}
                </button> */}
                <button
                  type="button"
                  className="btn secondary"
                  onClick={handleDownloadOriginal}
                  disabled={downloading}
                >
                  {downloading ? '다운로드 중...' : '텍스트 다운로드'}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={closeDetail}
                >
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

            {/* 날짜 탭 */}
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
              />
            )}

            {detail.loading ? (
              <></>
            ) : (
              <>
                <div className="detail-layout detail-layout-modern">
                  {/* 왼쪽: 날짜별 원본 텍스트 */}
                  <section className="detail-left">
                    <div className="detail-panel">
                      <div className="detail-panel-head">
                        <h4>원본 텍스트</h4>
                        <hr />
                        <p className="card-subtitle">
                          선택한 날짜에 해당하는 활동 기록 원문입니다.
                        </p>
                      </div>
                      <br />
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
                              rawByDate[activeDate] = e.target.value
                              next.rawTextByDate = rawByDate

                              if (dates.length === 1) {
                                next.editedText = e.target.value
                              }
                            } else {
                              next.editedText = e.target.value
                            }

                            return next
                          })
                        }
                        placeholder="원본 텍스트를 편집하여 저장할 수 있습니다."
                      />
                      <p className="detail-helper-text" />
                    </div>
                  </section>

                  {/* 오른쪽: 학생별 활동/감정/특이사항 */}
                                    {/* 오른쪽: 학생별 활동/감정/특이사항 */}
                  <section className="detail-right">
                    {(() => {
                      // 현재 날짜/학생 기준으로 서버 분석값을 안전하게 가져오기
                      const { activeId, analysis: a, activityTypes } =
                        getActiveStudentState(detail)

                      const activeStudent =
                        (detail.students || []).find(s => s.id === activeId) ||
                        null

                      const studentsText =
                        activeStudent?.label ||
                        activeStudent?.name ||
                        detail.upload.student_name

                      const dateValue = a.date
                        ? formatDate(a.date)
                        : formatDate(detail.activeDate || detail.upload.uploaded_at) ||
                          ''

                      const { hours, minutes } = splitDuration(
                        a.durationMinutes || 0,
                      )
                      const safeHours = Number.isNaN(hours) ? 0 : hours
                      const safeMinutes = Number.isNaN(minutes) ? 0 : minutes

                      const activities = Array.isArray(a.activities)
                        ? a.activities
                        : []

                      return (
                        <div className="analysis-panel">
                          <div className="analysis-panel-header">
                            <h4>학생별 활동/감정 편집</h4>
                            <p className="card-subtitle">
                              {formatDate(detail.activeDate)} ·{' '}
                              {studentsText || '학생 미지정'}
                            </p>
                          </div>
                          <br></br>

                          {/* 학생 탭 */}
                          <div
                            className="student-tabs-row"
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
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
                              {(detail.students || []).map(stu => {
                                // ✅ 실제로 표시 중인 activeId 기준으로 탭 상태 표시
                                const isActive = stu.id === activeId
                                return (
                                  <button
                                    key={stu.id}
                                    type="button"
                                    className={`emotion-chip ${
                                      isActive
                                        ? 'emotion-chip-selected'
                                        : 'emotion-chip-unselected'
                                    } student-tab`}
                                    onClick={() => handleSelectStudent(stu.id)}
                                  >
                                    <span className="emotion-chip-label">
                                      {stu.label || stu.name}
                                    </span>
                                    <span
                                      className="emotion-chip-icon"
                                      style={{ marginLeft: 4 }}
                                      onClick={e => {
                                        e.stopPropagation()
                                        handleRemoveStudent(stu.id)
                                      }}
                                    >
                                      ×
                                    </span>
                                  </button>
                                )
                              })}
                              {(!detail.students ||
                                detail.students.length === 0) && (
                                <span
                                  className="muted"
                                  style={{ fontSize: 12 }}
                                >
                                  학생 없음
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={handleAddStudent}
                            >
                              + 학생 추가
                            </button>
                          </div>

                          {/* 학생 선택 드롭다운 (Supabase 학생 목록) */}
                          {studentPickerOpen && (
                            <div
                              className="student-picker-row"
                              style={{
                                display: 'flex',
                                justifyContent: 'flex-end',
                                gap: 8,
                                marginBottom: 12,
                              }}
                            >
                              <select
                                className="analysis-input"
                                style={{ maxWidth: 260 }}
                                value={studentPickerValue}
                                onChange={e =>
                                  setStudentPickerValue(e.target.value)
                                }
                              >
                                <option value="">학생 선택</option>
                                {studentsMaster
                                  .filter(
                                    stu =>
                                      !(detail.students || []).some(
                                        s =>
                                          String(s.id) === String(stu.id),
                                      ),
                                  )
                                  .map(stu => (
                                    <option key={stu.id} value={stu.id}>
                                      {stu.label || stu.name}
                                    </option>
                                  ))}
                              </select>
                              <button
                                type="button"
                                className="btn secondary small"
                                onClick={handleAddStudentFromPicker}
                              >
                                추가
                              </button>
                            </div>
                          )}

                          <div className="analysis-scroll-panel">
                            {/* 1. 학생별 특이사항 + 날짜/총 시간 */}
                            <div className="analysis-section">
                              <div className="analysis-section-head">
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                  }}
                                >
                                  <h5>
                                    학생별 특이사항 ·{' '}
                                    {studentsText || '학생 미지정'}
                                  </h5>
                                  {a.isAiGenerated && (
                                    <span className="badge badge-warning">
                                      AI 자동 추출
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="analysis-grid">
                                <label style={{ fontSize: 12 }}>특이사항 / 교사 코멘트</label>
                                <textarea
                                  className="analysis-input"
                                  style={{
                                    minHeight: '80px',
                                    resize: 'vertical',
                                  }}
                                  value={a.note || ''}
                                  placeholder="AI가 채운 내용이 있으면 먼저 확인하고, 필요하면 수정해 주세요."
                                  onChange={e =>
                                    updateEditedAnalysis({
                                      note: e.target.value,
                                    })
                                  }
                                />
                                <label style={{ fontSize: 12 }}>총 소요 시간</label>
                                <div className="time-input-group" style={{ maxWidth: 320 }}>
                                  <input
                                    type="number"
                                    min="0"
                                    className="analysis-input time-input"
                                    value={safeHours}
                                    onChange={e =>
                                      updateEditedAnalysis({
                                        durationMinutes:
                                          Number(e.target.value) * 60 + safeMinutes,
                                      })
                                    }
                                  />
                                  <span className="time-separator">시간</span>
                                  <input
                                    type="number"
                                    min="0"
                                    max="59"
                                    className="analysis-input time-input"
                                    value={safeMinutes}
                                    onChange={e =>
                                      updateEditedAnalysis({
                                        durationMinutes: safeHours * 60 + Number(e.target.value),
                                      })
                                    }
                                  />
                                  <span className="time-separator">분</span>
                                </div>
                              </div>
                            </div>

                            {/* 2. 활동 목록 섹션 제거됨 */}

                            {/* 3. 활동 유형 (수확/파종/관리/관찰/기타) */}
                            <div className="analysis-section">
                              <div className="analysis-section-head">
                                <div>
                                  <h5>활동 유형 (수확/파종/관리/관찰/기타)</h5>
                                  <p className="section-helper">
                                    상단의 활동 목록과 별도로, 큰 카테고리
                                    유형을 체크할 수 있습니다.
                                  </p>
                                </div>
                              </div>
                              <div className="activity-type-grid">
                                {Object.entries(activityTypes || {}).map(
                                  ([key, item]) => (
                                    <div
                                      key={key}
                                      className={item.selected ? 'activity-type-card selected' : 'activity-type-card'}
                                    >
                                      <button
                                        type="button"
                                        className="activity-type-toggle"
                                        onClick={() => toggleActivityTypeSelection(key)}
                                      >
                                        <span className="activity-type-icon">
                                          {item.icon || '•'}
                                        </span>
                                        <span className="activity-type-label">
                                          {item.label}
                                        </span>
                                      </button>
                                      {item.selected && (
                                        <div style={{ marginTop: 8 }}>
                                          <textarea
                                            className="activity-type-detail"
                                            value={item.detail || ''}
                                            placeholder={`${item.label} 관련 상세 내용`}
                                            onChange={e =>
                                              updateActivityTypeDetail(
                                                key,
                                                e.target.value,
                                              )
                                            }
                                          />
                                          <div style={{ marginTop: 8 }}>
                                            <EmotionKeywordSelector
                                              masterList={emotionKeywords}
                                              selected={Array.isArray(item.emotionTags) ? item.emotionTags : []}
                                              onToggle={label => toggleActivityTypeEmotionTag(key, label)}
                                              onAddNew={label => addEmotionKeywordForType(key, label)}
                                            />
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  ),
                                )}
                              </div>
                            </div>
                            {/* 4. 전체 감정 키워드 섹션 제거됨 */}
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
          <></>
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

function EmotionKeywordSelector({
  masterList,
  selected,
  onToggle,
  onAddNew,
}) {
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
