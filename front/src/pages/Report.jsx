// src/pages/Report.jsx
import React, { useEffect, useState } from 'react'
import Layout from '../components/Layout.jsx'
import { apiFetch, generateReportWithGemini } from '../lib/api.js'

// 백엔드 베이스 URL
const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_BASE ||
  'http://localhost:3000'

// 로그인한 사용자 정보를 localStorage에서 가져오는 유틸
function getCurrentUser() {
  if (typeof window === 'undefined') return null
  try {
    const raw =
      window.localStorage.getItem('auth') ||
      window.localStorage.getItem('user') ||
      window.localStorage.getItem('dreamgarden_auth')

    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed.user || parsed
  } catch {
    return null
  }
}

// 🔹 리포트 카테고리 메타 정보
const REPORT_CATEGORY_CONFIG = {
  all: {
    code: 'all',
    label: '전체',
    description: '기간 동안의 전반적인 활동, 감정, 능력 변화를 종합적으로 요약합니다.',
  },
  full: {
    code: 'full',
    label: '전체 리포트',
    description: '감정, 활동, 능력 변화를 모두 포함하는 전체 종합 리포트입니다.',
  },
  emotion: {
    code: 'emotion',
    label: '감정 변화',
    description: '기간 동안의 감정 분포와 변화 양상을 중심으로 리포트를 생성합니다.',
  },
  activity_ratio: {
    code: 'activity_ratio',
    label: '활동 비율 변화',
    description: '어떤 활동을 얼마나 했는지, 활동 유형의 비율 변화를 중심으로 리포트를 생성합니다.',
  },
  ability_growth: {
    code: 'ability_growth',
    label: '능력 성장 곡선',
    description: '학생의 활동 수행 능력이 시간에 따라 어떻게 변화했는지를 중심으로 리포트를 생성합니다.',
  },
}

// 🔹 남은 시간 계산
function getRemainingInfo(report, nowTs) {
  if (!report.expiresAt) {
    return { expired: false, label: '만료 기간 정보 없음' }
  }
  const expiresAtTs = new Date(report.expiresAt).getTime()
  const diffMs = expiresAtTs - nowTs
  if (diffMs <= 0) return { expired: true, label: '만료됨' }

  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (diffDays > 0) return { expired: false, label: `${diffDays}일 남음` }
  if (diffHours > 0) return { expired: false, label: `${diffHours}시간 남음` }
  return { expired: false, label: '곧 만료' }
}

// 🔹 백엔드에서 내려온 report-runs 데이터를 화면용으로 정규화
function normalizeReportRuns(rawRuns) {
  if (!Array.isArray(rawRuns)) return []

  return rawRuns.map(run => {
    const params = run.params || run.filters || {}
    const template = run.template || {}
    const outputs = Array.isArray(run.outputs) ? run.outputs : []

    const studentName =
      run.student_name ||
      params.student_name ||
      (run.student && run.student.name) ||
      '학생 이름 미상'

    const categoryCode = params.category_code || template.category_code
    const categoryLabel =
      params.category_label ||
      template.category_label ||
      REPORT_CATEGORY_CONFIG[categoryCode]?.label ||
      '리포트'

    const purposeCode =
      params.purpose || template.purpose || run.purpose || 'other'

    const purposeLabel =
      params.purpose_label ||
      (purposeCode === 'parent'
        ? '학부모 상담용'
        : purposeCode === 'school'
        ? '학교 제출용'
        : purposeCode === 'all'
        ? '전체 용도'
        : null)

    const createdAt = run.created_at
    const expiresAt =
      run.expires_at ??
      (createdAt
        ? new Date(new Date(createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : null)

    const firstMd =
      outputs.find(o => o.format === 'md' || o.format === 'markdown') || run.md_output

    const analysisFrom = params.from || params.date_from || params.start_date || null
    const analysisTo = params.to || params.date_to || params.end_date || null

    return {
      id: run.id,
      templateCode: template.code || params.template_code || 'custom',
      templateName: template.name || categoryLabel,
      studentName,
      summary: run.summary || params.summary || '',
      createdAt,
      expiresAt,
      status: run.status || 'completed',
      mdDownloadPath:
        firstMd?.download_path ||
        (run.id ? `/report-runs/${run.id}/download?format=md` : null),
      raw: run,
      purposeLabel,
      analysisFrom,
      analysisTo,
    }
  })
}

// 학생 이름/별칭 label 생성 헬퍼
function getStudentLabel(student) {
  if (!student) return '학생'
  const name =
    student.name ||
    student.student_name ||
    ''
  const alias =
    student.alias ||
    student.student_alias ||
    ''
  if (name && alias) return `${name}(${alias})`
  return name || alias || '학생'
}

export default function Report() {
  const [currentUser] = useState(() => getCurrentUser())

  // 필터/생성용 상태
  const [filterMode, setFilterMode] = useState('range')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [singleDate, setSingleDate] = useState('')
  const [category, setCategory] = useState('all')
  const [studentId, setStudentId] = useState('all')
  const [purpose, setPurpose] = useState('all')

  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [students, setStudents] = useState([])
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [studentsError, setStudentsError] = useState(null)

  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState(null)

  const [nowTs, setNowTs] = useState(Date.now())

  // 최근 활동 기반 퀵 버튼용 로그
  const [recentActivities, setRecentActivities] = useState([])
  const [recentActivitiesLoading, setRecentActivitiesLoading] = useState(false)

  const isInvalidRange =
    filterMode === 'range' && startDate && endDate && startDate > endDate

  // 🔹 현재 선택 상태로 "생성 가능 여부" 계산 (버튼 비활성화용)
  const fromValue =
    filterMode === 'range'
      ? startDate || null
      : singleDate || null

  const canGenerate =
    !!fromValue &&
    !isInvalidRange &&
    studentId &&
    studentId !== 'all' &&
    category &&
    category !== 'all' &&
    purpose &&
    purpose !== 'all'

  async function fetchReports() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch('/report-runs')
      const runs = Array.isArray(data?.runs)
        ? data.runs
        : Array.isArray(data)
        ? data
        : []

      let normalized = normalizeReportRuns(runs)
      if (currentUser?.id) {
        const userId = currentUser.id
        normalized = normalized.filter(r => {
          const params = (r.raw && r.raw.params) || {}
          const createdBy = params.created_by_user_id || r.raw?.requested_by
          if (!createdBy) return true
          return createdBy === userId
        })
      }
      normalized.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      setReports(normalized)
    } catch (err) {
      console.error(err)
      setError('리포트 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  async function fetchStudents() {
    setStudentsLoading(true)
    setStudentsError(null)
    try {
      const data = await apiFetch(
        `/api/students?limit=1000&status=${encodeURIComponent('재학중')}`,
      )
      const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
        ? data
        : []

      const normalized = items
        .map(s => {
          const id = s.id ?? s.student_id ?? s.uuid
          if (!id) return null
          const name =
            s.name ??
            s.student_name ??
            s.full_name ??
            '이름 없음'
          const alias =
            s.alias ??
            s.student_alias ??
            ''
          const label =
            name && alias
              ? `${name}(${alias})`
              : name || alias || '이름 없음'
          return {
            ...s,
            id,
            name,
            alias,
            label,
          }
        })
        .filter(Boolean)

      setStudents(normalized)
    } catch (err) {
      console.error(err)
      setStudentsError('학생 목록을 불러오지 못했습니다.')
    } finally {
      setStudentsLoading(false)
    }
  }

  // 선택된 학생의 최근 활동(기본 50개) 로딩 → 퀵 버튼에서 사용
  async function fetchRecentActivitiesForStudent(selectedId) {
    if (!selectedId || selectedId === 'all') {
      setRecentActivities([])
      return
    }
    setRecentActivitiesLoading(true)
    try {
      const data = await apiFetch(
        `/api/log_entries?student_id=${encodeURIComponent(selectedId)}&limit=50`,
      )
      const items = Array.isArray(data?.items) ? data.items : data || []
      setRecentActivities(items)
    } catch (err) {
      console.error(err)
      setRecentActivities([])
    } finally {
      setRecentActivitiesLoading(false)
    }
  }

  useEffect(() => {
    fetchReports()
    fetchStudents()
  }, [currentUser])

  // 기본 날짜: 최근 1개월
  useEffect(() => {
    const today = new Date()
    const end = today.toISOString().slice(0, 10)
    const past = new Date()
    past.setDate(today.getDate() - 30)
    const start = past.toISOString().slice(0, 10)

    setFilterMode('range')
    setStartDate(start)
    setEndDate(end)
  }, [])

  // 학생이 바뀌면 최근 활동 가져오기 (퀵 버튼용)
  useEffect(() => {
    fetchRecentActivitiesForStudent(studentId)
  }, [studentId])

  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  const totalCount = reports.length

  function handleResetFilters() {
    setFilterMode('range')
    setSingleDate('')
    setCategory('all')
    setStudentId('all')
    setPurpose('all')

    const today = new Date()
    const end = today.toISOString().slice(0, 10)
    const past = new Date()
    past.setDate(today.getDate() - 30)
    const start = past.toISOString().slice(0, 10)
    setStartDate(start)
    setEndDate(end)
  }

  async function handleDelete(report) {
    if (!window.confirm(`"${report.templateName}" 리포트를 삭제하시겠습니까?`)) return
    try {
      await apiFetch(`/report-runs/${report.id}`, { method: 'DELETE' })
      setReports(prev => prev.filter(r => r.id !== report.id))
    } catch (err) {
      console.error(err)
      alert('리포트 삭제 중 오류가 발생했습니다.')
    }
  }

  // 🔹 최근 활동 N회 기반으로 날짜 자동 설정
  function applyRecentActivityRange(count) {
    if (!studentId || studentId === 'all') {
      alert('먼저 학생을 선택해 주세요.')
      return
    }

    if (!recentActivities || recentActivities.length === 0) {
      if (recentActivitiesLoading) {
        alert('학생의 활동 기록을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.')
      } else {
        alert('선택한 학생의 활동 기록이 아직 없습니다.')
      }
      return
    }

    const withDate = recentActivities
      .map(item => {
        const dateStr =
          item.log_date ||
          (item.created_at ? String(item.created_at).slice(0, 10) : null)
        if (!dateStr) return null
        return { ...item, _date: dateStr }
      })
      .filter(Boolean)

    if (withDate.length === 0) {
      alert('활동 기록에 날짜 정보가 없어 기간을 계산할 수 없습니다.')
      return
    }

    const sorted = [...withDate].sort((a, b) => a._date.localeCompare(b._date))
    const sliceStart = Math.max(sorted.length - count, 0)
    const selected = sorted.slice(sliceStart)

    if (selected.length === 0) {
      alert('선택한 범위에 해당하는 활동 기록이 없습니다.')
      return
    }

    const fromDate = selected[0]._date
    const toDate = selected[selected.length - 1]._date

    setFilterMode('range')
    setStartDate(fromDate)
    setEndDate(toDate)
  }

  // 🔹 md 리포트 다운로드
  async function handleDownloadMd(report) {
    const fileName = `${report.studentName || 'report'}_${report.createdAt?.slice(0, 10)}.md`

    const markdownFromParams = report?.raw?.params?.markdown
    if (markdownFromParams && typeof markdownFromParams === 'string') {
      try {
        const blob = new Blob([markdownFromParams], { type: 'text/markdown;charset=utf-8' })
        const downloadUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = downloadUrl
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(downloadUrl)
        return
      } catch (err) {
        console.error('클라이언트 다운로드 오류:', err)
      }
    }

    const path = report.mdDownloadPath
    if (!path) {
      alert('다운로드 경로가 없습니다.')
      return
    }

    const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`

    try {
      const res = await fetch(url)
      if (!res.ok) {
        if (res.status === 404) throw new Error('서버에 저장된 마크다운 파일이 없습니다.')
        throw new Error('다운로드 실패')
      }
      const blob = await res.blob()
      const downloadUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(downloadUrl)
    } catch (err) {
      console.error(err)
      alert(`리포트 다운로드 중 오류가 발생했습니다.\n(${err.message})`)
    }
  }

  async function handleGenerateAiReport() {
    if (filterMode === 'range' && isInvalidRange) {
      alert('시작일이 종료일보다 늦을 수 없습니다.')
      return
    }

    const from = filterMode === 'range' ? startDate || null : singleDate || null
    const to = filterMode === 'range' ? endDate || startDate || null : singleDate || null

    if (!from) {
      alert('날짜를 선택해 주세요.')
      return
    }

    if (!studentId || studentId === 'all') {
      alert('학생을 선택해 주세요. (전체 학생에 대한 리포트는 생성할 수 없습니다.)')
      return
    }

    // 🔹 카테고리 전체 선택 방지
    if (!category || category === 'all') {
      alert('카테고리를 선택해 주세요. (전체 카테고리는 리포트 생성에 사용할 수 없습니다.)')
      return
    }

    // 🔹 용도 전체 선택 방지
    if (!purpose || purpose === 'all') {
      alert('용도를 선택해 주세요. (전체 용도는 리포트 생성에 사용할 수 없습니다.)')
      return
    }

    const categoryConfig = REPORT_CATEGORY_CONFIG[category] || REPORT_CATEGORY_CONFIG.all
    setGenerating(true)
    setGenerateError(null)

    try {
      const [studentProfile, summaryStats, activityLogs] = await Promise.all([
        apiFetch(`/api/students/${encodeURIComponent(studentId)}`).catch(() => null),
        apiFetch(`/api/dashboard?studentId=${studentId}&from=${from}&to=${to}`).catch(() => null),
        apiFetch(
          `/api/log_entries?student_id=${studentId}&from=${from}&to=${to}&limit=50`,
        ).catch(() => null),
      ])

      const logItems = Array.isArray(activityLogs?.items)
        ? activityLogs.items
        : Array.isArray(activityLogs)
        ? activityLogs
        : []

      const activitySamples = logItems.map(item => {
        const metrics0 = Array.isArray(item.related_metrics)
          ? item.related_metrics[0]
          : item.related_metrics && typeof item.related_metrics === 'object'
          ? item.related_metrics
          : null

        const activities =
          (metrics0 && Array.isArray(metrics0.activities)
            ? metrics0.activities
            : []) || []

        const note =
          (metrics0 && (metrics0.note || metrics0.notes)) ||
          ''

        const emotionSummary =
          (metrics0 &&
            (metrics0.emotionSummary || metrics0.emotion_summary)) ||
          item.emotion_tag ||
          ''

        return {
          id: item.id,
          date:
            item.log_date ||
            (item.created_at &&
              String(item.created_at).slice(0, 10)) ||
            null,
          emotion_tag: item.emotion_tag || null,
          emotion_tags:
            item.emotion_tags ||
            metrics0?.emotionTags ||
            metrics0?.emotion_tags ||
            null,
          activity_tags: item.activity_tags || [],
          log_content: item.log_content || '',
          related_metrics: item.related_metrics || [],
          activities,
          note,
          emotionSummary,
        }
      })

      const effectivePurpose =
        !purpose || purpose === 'all' ? 'all' : purpose

      const tone =
        effectivePurpose === 'parent'
          ? '부드럽고 공감적인 학부모 상담용 톤'
          : effectivePurpose === 'school'
          ? '학교 제출용 공식적인 톤'
          : '교사가 참고하기 좋은 중립적인 톤'

      const aiPayload = {
        student_profile: studentProfile,
        date_range: { from, to },
        summary_stats: summaryStats,
        activity_samples: activitySamples,
        report_options: {
          purpose: effectivePurpose,
          tone,
          category_code: categoryConfig.code,
          category_label: categoryConfig.label,
          student_id: studentId,
          filter_mode: filterMode,
        },
      }

      const result = await generateReportWithGemini(aiPayload)
      const markdown = result.markdown || result.text || ''
      if (!markdown) throw new Error('AI가 리포트 내용을 반환하지 않았습니다.')

      const profileStudent =
        studentProfile ||
        students.find(s => s.id === studentId) ||
        null
      const studentLabel = getStudentLabel(profileStudent)

      const dateLabel =
        from && to && from !== to ? `${from} ~ ${to}` : from || ''
      const categoryLabel = categoryConfig.label || '종합 리포트'
      const title = `${studentLabel} ${dateLabel} ${categoryLabel}`.trim()

      let purposeLabel = null
      if (effectivePurpose === 'parent') purposeLabel = '학부모 상담용'
      else if (effectivePurpose === 'school') purposeLabel = '학교 제출용'
      else if (effectivePurpose === 'all') purposeLabel = '전체 용도'

      const reportParams = {
        title,
        from,
        to,
        filter_mode: filterMode,
        category_code: categoryConfig.code,
        category_label: categoryConfig.label,
        purpose: effectivePurpose,
        purpose_label: purposeLabel,
        student_id: studentId,
        student_name: studentLabel,   // ✅ 이름(별칭) label 사용
        markdown,
        created_by_user_id: currentUser?.id,
        created_by_name:
          currentUser?.display_name || currentUser?.email,
      }

      await apiFetch('/report-runs', {
        method: 'POST',
        body: {
          template_code: 'ai_markdown',
          requested_by: currentUser?.id,
          params: reportParams,
        },
      })

      // 🔹 생성 직후 목록 자동 갱신
      await fetchReports()
      alert('AI 리포트가 성공적으로 생성되었습니다.')
    } catch (err) {
      console.error(err)
      setGenerateError('AI 리포트 생성 중 오류가 발생했습니다.')
      alert('AI 리포트 생성 실패')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Layout>
      <div className="page-container">
        <header className="page-header">
          <div>
            <h1 className="page-title">AI 리포트</h1>
            <p className="page-subtitle">
              로그인한 사용자가 생성한 리포트들을 한눈에 보고, 새로운 AI 리포트를 제작해 보세요.
            </p>
          </div>
        </header>

        <div className="page-content report-layout">
          {/* 필터 섹션 */}
          <section className="report-filter-section">
            <div className="card report-filter-card">
              <form onSubmit={e => e.preventDefault()}>
                <div className="report-filter-title-row">
                  <div className="filter-icon">🧾</div>
                  <div>
                    <div className="card-title">리포트 제작 설정</div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      날짜, 카테고리, 학생, 용도를 선택하여 AI 리포트를 생성합니다.
                    </div>
                    {studentsLoading && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        재학중 학생 목록을 불러오는 중입니다...
                      </div>
                    )}
                    {studentsError && (
                      <div className="error" style={{ fontSize: 11, marginTop: 4 }}>
                        {studentsError}
                      </div>
                    )}
                  </div>
                </div>

                <div className="report-filter-block">
                  <div className="filter-label-row">
                    <span className="filter-label">날짜 필터 방식</span>
                  </div>
                  <div className="filter-radio-row">
                    <button
                      type="button"
                      className={`filter-toggle ${
                        filterMode === 'range' ? 'active' : ''
                      }`}
                      onClick={() => setFilterMode('range')}
                    >
                      날짜 범위
                    </button>
                    <button
                      type="button"
                      className={`filter-toggle ${
                        filterMode === 'single' ? 'active' : ''
                      }`}
                      onClick={() => setFilterMode('single')}
                    >
                      특정 날짜
                    </button>
                  </div>
                </div>

                <div className="report-filter-grid">
                  {filterMode === 'range' ? (
                    <>
                      <div className="filter-field">
                        <label>시작 날짜</label>
                        <input
                          type="date"
                          value={startDate}
                          max={endDate || undefined}
                          onChange={e => setStartDate(e.target.value)}
                        />
                      </div>
                      <div className="filter-field">
                        <label>종료 날짜</label>
                        <input
                          type="date"
                          value={endDate}
                          min={startDate || undefined}
                          onChange={e => setEndDate(e.target.value)}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="filter-field">
                      <label>날짜</label>
                      <input
                        type="date"
                        value={singleDate}
                        onChange={e => setSingleDate(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="filter-field">
                    <label>카테고리</label>
                    <select
                      value={category}
                      onChange={e => setCategory(e.target.value)}
                      className="report-select"
                    >
                      <option value="all">전체</option>
                      <option value="full">전체 리포트</option>
                      <option value="emotion">감정 변화</option>
                      <option value="activity_ratio">활동 비율 변화</option>
                      <option value="ability_growth">능력 성장 곡선</option>
                    </select>
                  </div>

                  <div className="filter-field">
                    <label>학생</label>
                    <select
                      value={studentId}
                      onChange={e => setStudentId(e.target.value)}
                      className="report-select"
                    >
                      <option value="all">전체</option>
                      {students.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.label || getStudentLabel(s)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="filter-field">
                    <label>용도</label>
                    <select
                      value={purpose}
                      onChange={e => setPurpose(e.target.value)}
                      className="report-select"
                    >
                      <option value="all">전체</option>
                      <option value="parent">학부모 상담용</option>
                      <option value="school">학교 제출용</option>
                    </select>
                  </div>
                </div>

                {/* 🔹 최근 활동 기반 퀵 버튼 */}
                {filterMode === 'range' && (
                  <div className="report-quick-row" style={{ marginTop: 8 }}>
                    <div className="filter-label-row" style={{ marginBottom: 4 }}>
                      <span className="filter-label">
                        빠른 선택 (최근 활동 기준)
                      </span>
                      {recentActivitiesLoading && (
                        <span
                          className="muted"
                          style={{ fontSize: 11, marginLeft: 8 }}
                        >
                          활동 기록을 불러오는 중...
                        </span>
                      )}
                    </div>
                    <div className="filter-radio-row">
                      <button
                        type="button"
                        className="filter-toggle"
                        onClick={() => applyRecentActivityRange(5)}
                      >
                        최근 활동 5회
                      </button>
                      <button
                        type="button"
                        className="filter-toggle"
                        onClick={() => applyRecentActivityRange(10)}
                      >
                        최근 활동 10회
                      </button>
                    </div>
                    <div
                      className="muted"
                      style={{ fontSize: 11, marginTop: 4 }}
                    >
                      선택한 학생의 최근 활동 횟수를 기준으로 시작/종료 날짜를 자동 설정합니다.
                    </div>
                  </div>
                )}

                <div className="report-filter-footer">
                  <span className="muted">
                    현재 리포트 수: <strong>{totalCount}</strong>개
                  </span>
                  <div className="report-filter-actions">
                    <button
                      type="button"
                      className="btn secondary report-reset-btn"
                      onClick={handleResetFilters}
                    >
                      필터 초기화
                    </button>
                    <button
                      type="button"
                      className="btn secondary report-ai-btn"
                      onClick={handleGenerateAiReport}
                      disabled={generating || !canGenerate}
                    >
                      {generating ? '생성 중...' : 'AI 리포트 생성(.md)'}
                    </button>
                  </div>
                </div>
                {isInvalidRange && (
                  <div
                    className="error"
                    style={{ fontSize: 12, marginTop: 4 }}
                  >
                    날짜 범위를 확인해주세요.
                  </div>
                )}
                {generateError && (
                  <div className="error" style={{ marginTop: 4 }}>
                    {generateError}
                  </div>
                )}
              </form>
            </div>
          </section>

          {/* 목록 섹션 */}
          <section className="report-list-section">
            <div className="card report-list-card">
              <div className="card-header-row">
                <div className="card-title">리포트 목록</div>
              </div>
              <p></p>

              {loading ? (
                <div className="card-body">
                  <div className="loading-text">Loading...</div>
                </div>
              ) : error ? (
                <div className="card-body">
                  <div className="error">{error}</div>
                </div>
              ) : totalCount === 0 ? (
                <div className="card-body">
                  <div className="empty-state">생성된 리포트가 없습니다.</div>
                </div>
              ) : (
                <div className="report-list">
                  {reports.map(report => {
                    const remaining = getRemainingInfo(report, nowTs)
                    const rangeText =
                      report.analysisFrom || report.analysisTo
                        ? `${report.analysisFrom || '?'} ~ ${
                            report.analysisTo || '?'
                          }`
                        : null
                    return (
                      <article
                        key={report.id}
                        className={`report-card ${
                          remaining.expired ? 'report-card-expired' : ''
                        }`}
                      >
                        <div className="report-card-main">
                          <div className="report-card-header">
                            <div className="report-card-title">
                              <span className="report-card-student">
                                🔗 {report.studentName}
                              </span>
                              {report.purposeLabel && (
                                <span className="report-chip report-chip-purpose">
                                  {report.purposeLabel}
                                </span>
                              )}
                              <span
                                className={`report-chip report-chip-state ${
                                  remaining.expired ? 'expired' : ''
                                }`}
                              >
                                {remaining.expired ? '만료됨' : '진행 중'}
                              </span>
                            </div>
                          </div>
                          {rangeText && (
                            <div className="report-card-meta-row">
                              분석 기간: {rangeText}
                            </div>
                          )}
                          <div className="report-card-remaining-row">
                            <span className="report-remaining-icon">⏱</span>
                            <span
                              className={`report-remaining-text ${
                                remaining.expired ? 'danger' : ''
                              }`}
                            >
                              남은 시간: {remaining.label}
                            </span>
                          </div>
                        </div>
                        <div className="report-card-actions">
                          <button
                            type="button"
                            className="btn secondary-outline report-btn"
                            onClick={() => handleDownloadMd(report)}
                          >
                            다운로드
                          </button>
                          <button
                            type="button"
                            className="btn danger-outline report-btn"
                            onClick={() => handleDelete(report)}
                          >
                            삭제
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </Layout>
  )
}

export { Report }
