// src/pages/StudentList.jsx
import React, { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import { apiFetch } from '../lib/api'

// 서버 응답 형태를 통합해서 students 배열로 변환
function normalizeStudentsResponse(res) {
  if (!res) return []
  if (Array.isArray(res.items)) return res.items
  if (Array.isArray(res.data)) return res.data
  if (Array.isArray(res)) return res
  return []
}

// 상태 드롭다운에서 사용할 옵션들
const STATUS_OPTIONS = ['재학중', '졸업', '중도이탈', '휴학']
// 학교 단계 옵션
const SCHOOL_LEVEL_OPTIONS = ['', '초등', '중등', '고등', '기타']

// notes 컬럼을 [별칭] / [학교단계] / 메모로 분해
function decodeStudentNotes(notes) {
  const result = { alias: '', schoolLevel: '', memo: '' }
  if (!notes) return result

  const lines = String(notes).split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[별칭]')) {
      result.alias = trimmed.replace('[별칭]', '').trim()
    } else if (trimmed.startsWith('[학교단계]')) {
      result.schoolLevel = trimmed.replace('[학교단계]', '').trim()
    } else {
      result.memo += (result.memo ? '\n' : '') + line
    }
  }
  return result
}

// [별칭] / [학교단계] / 메모를 다시 notes 문자열로 합치기
function encodeStudentNotes(alias, schoolLevel, memo) {
  const lines = []
  if (alias && alias.trim()) {
    lines.push(`[별칭] ${alias.trim()}`)
  }
  if (schoolLevel && schoolLevel.trim()) {
    lines.push(`[학교단계] ${schoolLevel.trim()}`)
  }
  if (memo && memo.trim()) {
    lines.push(memo.trim())
  }
  return lines.join('\n') || null
}

export default function StudentList() {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ▶ 학생 추가용 상태들
  const [newName, setNewName] = useState('')
  const [newStatus, setNewStatus] = useState('재학중')
  const [newAdmissionDate, setNewAdmissionDate] = useState('')
  const [newBirthDate, setNewBirthDate] = useState('')
  const [newAlias, setNewAlias] = useState('')
  const [newSchoolLevel, setNewSchoolLevel] = useState('')
  const [newMemo, setNewMemo] = useState('')
  const [creating, setCreating] = useState(false)

  // ▶ 수정용 모달 상태
  const [editingStudent, setEditingStudent] = useState(null)
  const [editForm, setEditForm] = useState({
    name: '',
    status: '',
    admission_date: '',
    birth_date: '',
    alias: '',
    schoolLevel: '',
    memo: '',
  })
  const [savingEdit, setSavingEdit] = useState(false)

  // ▶ 삭제 처리 중인 학생 id
  const [deletingId, setDeletingId] = useState(null)

  // -------------------- 초기 학생 목록 조회 --------------------
  useEffect(() => {
    fetchStudents()
  }, [])

  async function fetchStudents() {
    try {
      setLoading(true)
      setError('')

      const res = await apiFetch('/api/students?limit=200&offset=0')
      const list = normalizeStudentsResponse(res)
      const enhanced = list.map(s => {
        const decoded = decodeStudentNotes(s.notes)
        return {
          ...s,
          alias: decoded.alias,
          schoolLevel: decoded.schoolLevel,
          memo: decoded.memo,
        }
      })
      setStudents(enhanced)
    } catch (e) {
      console.error(e)
      setError('학생 목록을 불러오는 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  // -------------------- 학생 추가 --------------------
  async function handleCreate(e) {
    e.preventDefault()
    if (!newName.trim()) {
      setError('이름을 입력해주세요.')
      return
    }

    try {
      setCreating(true)
      setError('')

      const notes = encodeStudentNotes(newAlias, newSchoolLevel, newMemo)

      const payload = {
        name: newName.trim(),
        status: newStatus || null,
        admission_date: newAdmissionDate || null,
        birth_date: newBirthDate || null,
        notes,
      }

      const created = await apiFetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const decoded = decodeStudentNotes(created.notes)
      const enhancedCreated = {
        ...created,
        alias: decoded.alias,
        schoolLevel: decoded.schoolLevel,
        memo: decoded.memo,
      }

      setStudents(prev => [...prev, enhancedCreated])

      // 입력창 초기화
      setNewName('')
      setNewStatus('재학중')
      setNewAdmissionDate('')
      setNewBirthDate('')
      setNewAlias('')
      setNewSchoolLevel('')
      setNewMemo('')
    } catch (e) {
      console.error(e)
      setError(e.message || '학생 추가 중 오류가 발생했습니다.')
    } finally {
      setCreating(false)
    }
  }

  // -------------------- 학생 수정 --------------------
  function openEditModal(student) {
    setEditingStudent(student || null)

    if (student) {
      const decoded = decodeStudentNotes(student.notes)
      setEditForm({
        name: student.name || '',
        status: student.status || '',
        admission_date: student.admission_date
          ? String(student.admission_date).slice(0, 10)
          : '',
        birth_date: student.birth_date
          ? String(student.birth_date).slice(0, 10)
          : '',
        alias: student.alias || decoded.alias || '',
        schoolLevel: student.schoolLevel || decoded.schoolLevel || '',
        memo: student.memo || decoded.memo || '',
      })
    } else {
      setEditForm({
        name: '',
        status: '',
        admission_date: '',
        birth_date: '',
        alias: '',
        schoolLevel: '',
        memo: '',
      })
    }
  }

  function closeEditModal() {
    setEditingStudent(null)
  }

  function handleEditChange(e) {
    const { name, value } = e.target
    setEditForm(prev => ({ ...prev, [name]: value }))
  }

  async function handleEditSave(e) {
    e.preventDefault()
    if (!editingStudent) return

    try {
      setSavingEdit(true)
      setError('')

      const notes = encodeStudentNotes(
        editForm.alias,
        editForm.schoolLevel,
        editForm.memo,
      )

      const payload = {
        name: editForm.name,
        status: editForm.status || null,
        admission_date: editForm.admission_date || null,
        birth_date: editForm.birth_date || null,
        notes,
      }

      const updated = await apiFetch(`/api/students/${editingStudent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const decoded = decodeStudentNotes(updated.notes)
      const enhancedUpdated = {
        ...updated,
        alias: decoded.alias,
        schoolLevel: decoded.schoolLevel,
        memo: decoded.memo,
      }

      setStudents(prev =>
        prev.map(s => (s.id === editingStudent.id ? enhancedUpdated : s)),
      )

      closeEditModal()
    } catch (e) {
      console.error(e)
      setError(e.message || '학생 수정 중 오류가 발생했습니다.')
    } finally {
      setSavingEdit(false)
    }
  }

  // -------------------- 학생 삭제 --------------------
  async function handleDelete(student) {
    if (!student) return
    if (!window.confirm(`"${student.name}" 학생을 정말 삭제하시겠어요?`)) return

    try {
      setDeletingId(student.id)
      setError('')

      await apiFetch(`/api/students/${student.id}`, {
        method: 'DELETE',
      })

      setStudents(prev => prev.filter(s => s.id !== student.id))
    } catch (e) {
      console.error(e)
      setError(e.message || '학생 삭제 중 오류가 발생했습니다.')
    } finally {
      setDeletingId(null)
    }
  }

  function getDisplayName(student) {
    const name = student.name || ''
    const alias = student.alias || ''
    if (alias && name) return `${alias}(${name})`
    return name || alias || '이름 없음'
  }

  // -------------------- JSX --------------------
  return (
    <Layout title="학생 관리">
      <div className="page-container" style={{ padding: 16 }}>
        {/* 상단 헤더 */}
        <div
          className="page-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
              학생 관리
            </h1>
            <p className="muted" style={{ fontSize: 13 }}>
              학생을 추가/수정/삭제 할 수 있습니다. (별칭과 학교 단계를 함께 관리해 보세요)
            </p>
          </div>
        </div>

        {/* 에러 / 로딩 */}
        {error && (
          <div
            style={{
              marginBottom: 12,
              padding: '8px 12px',
              borderRadius: 10,
              background: '#fef2f2',
              color: '#b91c1c',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {loading && (
          <div className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
            학생 목록을 불러오는 중입니다...
          </div>
        )}

        {/* ▶ 학생 추가 폼 */}
        <div
          className="card"
          style={{
            marginBottom: 16,
            padding: 16,
            borderRadius: 16,
            border: '1px solid #e5e7eb',
            background: '#ffffff',
          }}
        >
          <form onSubmit={handleCreate}>
            {/* 1행: 이름 + 별칭 + 학교단계 + 상태 */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              {/* 학생 이름 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: '#6b7280',
                    minWidth: 64,
                    flexShrink: 0,
                  }}
                >
                  학생 이름
                </span>
                <input
                  className="app-input"
                  type="text"
                  placeholder="예: 홍길동"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  style={{
                    width: 140,
                  }}
                />
              </div>

              {/* 별칭(alias) */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: '#6b7280',
                    minWidth: 52,
                    flexShrink: 0,
                  }}
                >
                  별칭
                </span>
                <input
                  className="app-input"
                  type="text"
                  placeholder="예: 꽃사슴"
                  value={newAlias}
                  onChange={e => setNewAlias(e.target.value)}
                  style={{
                    width: 140,
                  }}
                />
              </div>

              {/* 학교 단계 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: '#6b7280',
                    minWidth: 64,
                    flexShrink: 0,
                  }}
                >
                  학교 단계
                </span>
                <select
                  className="app-input"
                  value={newSchoolLevel}
                  onChange={e => setNewSchoolLevel(e.target.value)}
                  style={{
                    width: 120,
                    paddingRight: 28,
                  }}
                >
                  <option value="">선택 없음</option>
                  {SCHOOL_LEVEL_OPTIONS.filter(x => x).map(opt => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              {/* 상태 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: '#6b7280',
                    minWidth: 40,
                    flexShrink: 0,
                  }}
                >
                  상태
                </span>
                <select
                  className="app-input"
                  value={newStatus}
                  onChange={e => setNewStatus(e.target.value)}
                  style={{
                    width: 120,
                    paddingRight: 28,
                  }}
                >
                  {STATUS_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 2행: 입학일 + 생년월일 */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              {/* 입학일 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: '#6b7280',
                    minWidth: 48,
                    flexShrink: 0,
                  }}
                >
                  입학일
                </span>
                <input
                  className="app-input"
                  type="date"
                  value={newAdmissionDate}
                  onChange={e => setNewAdmissionDate(e.target.value)}
                  style={{
                    width: 140,
                    borderRadius: 999,
                  }}
                />
              </div>

              {/* 생년월일 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: '#6b7280',
                    minWidth: 60,
                    flexShrink: 0,
                  }}
                >
                  생년월일
                </span>
                <input
                  className="app-input"
                  type="date"
                  value={newBirthDate}
                  onChange={e => setNewBirthDate(e.target.value)}
                  style={{
                    width: 140,
                    borderRadius: 999,
                  }}
                />
              </div>
            </div>

            {/* 3행: 메모 (넓은 textarea) */}
            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 13,
                  color: '#6b7280',
                  marginBottom: 4,
                }}
              >
                메모(별명/특이사항)
              </div>
              <textarea
                className="app-textarea"
                placeholder="예: 좋아하는 활동, 특이사항 등을 적어주세요."
                value={newMemo}
                onChange={e => setNewMemo(e.target.value)}
                rows={4}
                style={{
                  width: '98%',
                  minWidth: 200,
                  fontSize: 13,
                }}
              />
            </div>

            {/* 하단: 학생 추가 버튼 (컨테이너 하단 우측) */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: 4,
              }}
            >
              <button
                type="submit"
                className="btn primary"
                disabled={creating}
                style={{
                  padding: '8px 14px',
                  borderRadius: 999,
                  border: 'none',
                  fontSize: 14,
                  fontWeight: 500,
                  background: '#2563eb',
                  color: '#ffffff',
                  cursor: creating ? 'default' : 'pointer',
                  opacity: creating ? 0.7 : 1,
                }}
              >
                {creating ? '추가 중...' : '학생 추가'}
              </button>
            </div>
          </form>
        </div>

        {/* ▶ 학생 목록 테이블 */}
        <div
          className="card"
          style={{
            borderRadius: 16,
            border: '1px solid #e5e7eb',
            background: '#ffffff',
            overflow: 'hidden',
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 14,
            }}
          >
            <thead
              style={{
                background: '#f9fafb',
                borderBottom: '1px solid #e5e7eb',
              }}
            >
              <tr>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    fontWeight: 500,
                    fontSize: 13,
                    color: '#6b7280',
                  }}
                >
                  이름(별칭)
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    fontWeight: 500,
                    fontSize: 13,
                    color: '#6b7280',
                  }}
                >
                  학교 단계
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    fontWeight: 500,
                    fontSize: 13,
                    color: '#6b7280',
                  }}
                >
                  상태
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    fontWeight: 500,
                    fontSize: 13,
                    color: '#6b7280',
                  }}
                >
                  입학일
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    fontWeight: 500,
                    fontSize: 13,
                    color: '#6b7280',
                  }}
                >
                  비고(메모)
                </th>
                <th
                  style={{
                    width: 180,
                    textAlign: 'right',
                    padding: '10px 12px',
                    fontWeight: 500,
                    fontSize: 13,
                    color: '#6b7280',
                  }}
                >
                  작업
                </th>
              </tr>
            </thead>
            <tbody>
              {students.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{
                      padding: '14px 12px',
                      fontSize: 13,
                      color: '#6b7280',
                    }}
                  >
                    학생이 없습니다. 상단에서 새 학생을 추가해보세요.
                  </td>
                </tr>
              ) : (
                students.map(student => {
                  const displayName = getDisplayName(student)
                  const statusLabel = student.status || '재학중'
                  const admissionDate = student.admission_date
                    ? String(student.admission_date).slice(0, 10)
                    : ''

                  return (
                    <tr
                      key={student.id}
                      style={{ borderBottom: '1px solid #f3f4f6' }}
                    >
                      <td style={{ padding: '10px 12px' }}>{displayName}</td>
                      <td
                        style={{
                          padding: '10px 12px',
                          fontSize: 13,
                          color: '#4b5563',
                        }}
                      >
                        {student.schoolLevel || '-'}
                      </td>
                      <td
                        style={{
                          padding: '10px 12px',
                          fontSize: 13,
                          color: '#4b5563',
                        }}
                      >
                        {statusLabel}
                      </td>
                      <td
                        style={{
                          padding: '10px 12px',
                          fontSize: 13,
                          color: '#4b5563',
                        }}
                      >
                        {admissionDate || '-'}
                      </td>
                      <td
                        style={{
                          padding: '10px 12px',
                          fontSize: 13,
                          color: '#6b7280',
                          maxWidth: 260,
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          overflow: 'hidden',
                        }}
                        title={student.memo || student.notes || ''}
                      >
                        {student.memo || student.notes || ''}
                      </td>
                      <td
                        style={{
                          padding: '10px 12px',
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => openEditModal(student)}
                          style={{
                            marginRight: 8,
                            padding: '6px 10px',
                            borderRadius: 999,
                            border: '1px solid #d1d5db',
                            background: '#ffffff',
                            fontSize: 13,
                            cursor: 'pointer',
                          }}
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          className="btn danger"
                          onClick={() => handleDelete(student)}
                          disabled={deletingId === student.id}
                          style={{
                            padding: '6px 10px',
                            borderRadius: 999,
                            border: 'none',
                            background: '#ef4444',
                            color: '#ffffff',
                            fontSize: 13,
                            cursor:
                              deletingId === student.id ? 'default' : 'pointer',
                            opacity: deletingId === student.id ? 0.7 : 1,
                          }}
                        >
                          {deletingId === student.id ? '삭제 중...' : '삭제'}
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

            {/* 수정 모달 */}
      {editingStudent && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            className="modal"
            style={{
              width: '100%',
              maxWidth: 600,
              borderRadius: 18,
              background: '#ffffff',
              position: 'relative',   
              padding: 24,
              boxShadow:
                '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)',
            }}
          >
            {/* 헤더 */}
            <div
              style={{
                marginBottom: 16,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h2
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    marginBottom: 2,
                  }}
                >
                  학생 정보 수정
                </h2>
                <p
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                  }}
                >
                  이름 · 별칭 · 학교 단계 · 메모를 한 번에 정리해 주세요.
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditModal}
                style={{
                  position: 'absolute',
                  top: 18,
                  right: 16,
                  border: 'none',
                  background: 'transparent',
                  fontSize: 20,
                  cursor: 'pointer',
                  lineHeight: 1,
                  color: '#9ca3af',
                }}
              >
                ×
              </button>
            </div>

            {/* 폼 본문 */}
            <form
              onSubmit={handleEditSave}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                columnGap: 16,
                rowGap: 12,
              }}
            >
              {/* 이름 */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    fontWeight: 500,
                  }}
                >
                  이름
                </span>
                <input
                  type="text"
                  name="name"
                  value={editForm.name}
                  onChange={handleEditChange}
                  required
                  style={{
                    width: '50%',
                    padding: '9px 12px',
                    borderRadius: 12,
                    border: '1px solid #d1d5db',
                    fontSize: 14,
                  }}
                />
              </label>

              {/* 별칭 */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    fontWeight: 500,
                  }}
                >
                  별칭
                </span>
                <input
                  type="text"
                  name="alias"
                  value={editForm.alias}
                  onChange={handleEditChange}
                  placeholder="동명이인 구분용 별칭"
                  style={{
                    width: '50%',
                    padding: '9px 12px',
                    borderRadius: 12,
                    border: '1px solid #d1d5db',
                    fontSize: 14,
                  }}
                />
              </label>

              {/* 학교 단계 */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    fontWeight: 500,
                  }}
                >
                  학교 단계
                </span>
                <select
                  name="schoolLevel"
                  value={editForm.schoolLevel}
                  onChange={handleEditChange}
                  style={{
                    width: '50%',
                    padding: '9px 12px',
                    borderRadius: 12,
                    border: '1px solid #d1d5db',
                    fontSize: 14,
                    backgroundColor: '#ffffff',
                  }}
                >
                  <option value="">선택 없음</option>
                  {SCHOOL_LEVEL_OPTIONS.filter(x => x).map(opt => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>

              {/* 상태 */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    fontWeight: 500,
                  }}
                >
                  상태
                </span>
                {(() => {
                  const hasCustomStatus =
                    editForm.status &&
                    !STATUS_OPTIONS.includes(editForm.status)
                  const options = hasCustomStatus
                    ? [editForm.status, ...STATUS_OPTIONS]
                    : STATUS_OPTIONS

                  return (
                    <select
                      name="status"
                      value={editForm.status || ''}
                      onChange={handleEditChange}
                      style={{
                        width: '50%',
                        padding: '9px 12px',
                        borderRadius: 12,
                        border: '1px solid #d1d5db',
                        fontSize: 14,
                        backgroundColor: '#ffffff',
                      }}
                    >
                      <option value="">선택 없음</option>
                      {options.map(opt => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  )
                })()}
              </label>

              {/* 입학일 */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    fontWeight: 500,
                  }}
                >
                  입학일
                </span>
                <input
                  type="date"
                  name="admission_date"
                  value={editForm.admission_date || ''}
                  onChange={handleEditChange}
                  style={{
                    width: '50%',
                    padding: '9px 12px',
                    borderRadius: 12,
                    border: '1px solid #d1d5db',
                    fontSize: 14,
                  }}
                />
              </label>

              {/* 생년월일 */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    fontWeight: 500,
                  }}
                >
                  생년월일
                </span>
                <input
                  type="date"
                  name="birth_date"
                  value={editForm.birth_date || ''}
                  onChange={handleEditChange}
                  style={{
                    width: '50%',
                    padding: '9px 12px',
                    borderRadius: 12,
                    border: '1px solid #d1d5db',
                    fontSize: 14,
                  }}
                />
              </label>

              {/* 메모 – 전체 폭 사용 */}
              <label
                style={{
                  gridColumn: '1 / -1',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    fontWeight: 500,
                  }}
                >
                  메모(별명/특이사항)
                </span>
                <textarea
                  name="memo"
                  value={editForm.memo}
                  onChange={handleEditChange}
                  rows={4}
                  style={{
                    width: '95%',
                    padding: '9px 12px',
                    borderRadius: 12,
                    border: '1px solid #d1d5db',
                    fontSize: 14,
                    resize: 'vertical',
                  }}
                  placeholder="이 학생에 대한 간단한 메모를 남겨보세요."
                />
              </label>

              {/* 버튼 영역 – 전체 폭 사용 */}
              <div
                style={{
                  gridColumn: '1 / -1',
                  marginTop: 8,
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  onClick={closeEditModal}
                  className="btn secondary"
                  style={{
                    padding: '8px 14px',
                    borderRadius: 999,
                    border: '1px solid #d1d5db',
                    background: '#ffffff',
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  취소
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={savingEdit}
                  style={{
                    padding: '8px 18px',
                    borderRadius: 999,
                    border: 'none',
                    background: '#2563eb',
                    color: '#ffffff',
                    fontSize: 14,
                    cursor: savingEdit ? 'default' : 'pointer',
                    opacity: savingEdit ? 0.7 : 1,
                  }}
                >
                  {savingEdit ? '저장 중...' : '저장'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Layout>
  )
}

export { StudentList }
