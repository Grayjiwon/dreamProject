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

  // ▶ 학생 수정용 모달 상태
  const [editingStudent, setEditingStudent] = useState(null)
  const [editForm, setEditForm] = useState({
    name: '',
    status: '재학중',
    admission_date: '',
    birth_date: '',
    alias: '',
    schoolLevel: '',
    memo: '',
  })
  const [savingEdit, setSavingEdit] = useState(false)

  // -------------------- 학생 목록 불러오기 --------------------
  useEffect(() => {
    fetchStudents()
  }, [])

  async function fetchStudents() {
    try {
      setLoading(true)
      setError('')

      const res = await apiFetch('/api/students')
      const list = normalizeStudentsResponse(res)

      const enhanced = list.map(s => {
        const decoded = decodeStudentNotes(s.notes)
        const alias =
          (s.alias !== undefined && s.alias !== null && s.alias !== '')
            ? s.alias
            : decoded.alias
        const schoolLevel =
          s.school_level ||
          s.schoolLevel ||
          decoded.schoolLevel
        const memo =
          (s.memo !== undefined && s.memo !== null && s.memo !== '')
            ? s.memo
            : decoded.memo

        return {
          ...s,
          alias,
          schoolLevel,
          memo,
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
        alias: newAlias || null,
        status: newStatus || null,
        admission_date: newAdmissionDate || null,
        birth_date: newBirthDate || null,
        school_level: newSchoolLevel || null,
        memo: newMemo || null,
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
        alias: created.alias || decoded.alias,
        schoolLevel:
          created.school_level ||
          created.schoolLevel ||
          decoded.schoolLevel,
        memo: created.memo || decoded.memo,
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
        schoolLevel:
          student.school_level ||
          student.schoolLevel ||
          decoded.schoolLevel ||
          '',
        memo: student.memo || decoded.memo || '',
      })
    } else {
      setEditForm({
        name: '',
        status: '재학중',
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
    setEditForm({
      name: '',
      status: '재학중',
      admission_date: '',
      birth_date: '',
      alias: '',
      schoolLevel: '',
      memo: '',
    })
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
        alias: editForm.alias || null,
        status: editForm.status || null,
        admission_date: editForm.admission_date || null,
        birth_date: editForm.birth_date || null,
        school_level: editForm.schoolLevel || null,
        memo: editForm.memo || null,
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
        alias: updated.alias || decoded.alias,
        schoolLevel:
          updated.school_level ||
          updated.schoolLevel ||
          decoded.schoolLevel,
        memo: updated.memo || decoded.memo,
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
      await apiFetch(`/api/students/${student.id}`, {
        method: 'DELETE',
      })
      setStudents(prev => prev.filter(s => s.id !== student.id))
    } catch (e) {
      console.error(e)
      setError('학생 삭제 중 오류가 발생했습니다.')
    }
  }

  // -------------------- 화면 표시용 이름 규칙 --------------------
  function getDisplayName(student) {
    const name = student.name || ''
    const alias = student.alias || ''
    if (name && alias) return `${name}(${alias})`
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
          <h1
            style={{
              fontSize: 20,
              fontWeight: 600,
              margin: 0,
            }}
          >
            학생 관리
          </h1>
        </div>

        {/* 에러 메시지 */}
        {error && (
          <div
            style={{
              marginBottom: 12,
              padding: 8,
              borderRadius: 4,
              backgroundColor: '#fee2e2',
              color: '#b91c1c',
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        {/* 학생 추가 폼 */}
        <form
          onSubmit={handleCreate}
          style={{
            marginBottom: 16,
            padding: 12,
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            backgroundColor: '#f9fafb',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: 8,
              marginBottom: 8,
            }}
          >
            {/* 이름 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#4b5563' }}>이름</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="app-input"
                style={{ padding: '6px 8px', fontSize: 14 }}
              />
            </div>

            {/* 별칭 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#4b5563' }}>별칭</label>
              <input
                type="text"
                value={newAlias}
                onChange={e => setNewAlias(e.target.value)}
                className="app-input"
                style={{ padding: '6px 8px', fontSize: 14 }}
              />
            </div>

            {/* 상태 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#4b5563' }}>상태</label>
              <select
                value={newStatus}
                onChange={e => setNewStatus(e.target.value)}
                className="app-input"
                style={{ padding: '6px 8px', fontSize: 14 }}
              >
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            {/* 학교 단계 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#4b5563' }}>학교 단계</label>
              <select
                value={newSchoolLevel}
                onChange={e => setNewSchoolLevel(e.target.value)}
                className="app-input"
                style={{ padding: '6px 8px', fontSize: 14 }}
              >
                {SCHOOL_LEVEL_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>
                    {opt || '선택 안 함'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 8,
              marginBottom: 8,
            }}
          >
            {/* 입학일 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#4b5563' }}>입학일</label>
              <input
                type="date"
                value={newAdmissionDate}
                onChange={e => setNewAdmissionDate(e.target.value)}
                className="app-input"
                style={{ padding: '6px 8px', fontSize: 14 }}
              />
            </div>

            {/* 생년월일 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#4b5563' }}>생년월일</label>
              <input
                type="date"
                value={newBirthDate}
                onChange={e => setNewBirthDate(e.target.value)}
                className="app-input"
                style={{ padding: '6px 8px', fontSize: 14 }}
              />
            </div>
          </div>

          {/* 메모 */}
          <div style={{ marginBottom: 8 }}>
            <label
              style={{
                display: 'block',
                marginBottom: 4,
                fontSize: 12,
                color: '#4b5563',
              }}
            >
              메모
            </label>
            <textarea
              value={newMemo}
              onChange={e => setNewMemo(e.target.value)}
              rows={3}
              className="app-input"
              style={{ width: '100%', fontSize: 14, padding: 8, resize: 'vertical' }}
            />
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: 8,
            }}
          >
            <button
              type="submit"
              disabled={creating}
              className="app-button"
              style={{
                padding: '6px 12px',
                fontSize: 14,
                borderRadius: 6,
                border: 'none',
                backgroundColor: creating ? '#9ca3af' : '#2563eb',
                color: '#ffffff',
                cursor: creating ? 'default' : 'pointer',
              }}
            >
              {creating ? '추가 중...' : '학생 추가'}
            </button>
          </div>
        </form>

        {/* 학생 목록 테이블 */}
        <div
          style={{
            borderRadius: 8,
            border: '1px solid #e5e7eb',
            overflow: 'hidden',
            backgroundColor: '#ffffff',
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 14,
            }}
          >
            <thead>
              <tr
                style={{
                  backgroundColor: '#f3f4f6',
                  textAlign: 'left',
                }}
              >
                <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>
                  이름 / 별칭
                </th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>
                  상태
                </th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>
                  학교 단계
                </th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>
                  입학일
                </th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>
                  생년월일
                </th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>
                  메모
                </th>
                <th
                  style={{
                    padding: '8px 10px',
                    borderBottom: '1px solid #e5e7eb',
                    width: 120,
                  }}
                >
                  수정
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      padding: 12,
                      textAlign: 'center',
                      color: '#6b7280',
                    }}
                  >
                    불러오는 중...
                  </td>
                </tr>
              ) : students.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      padding: 12,
                      textAlign: 'center',
                      color: '#6b7280',
                    }}
                  >
                    등록된 학생이 없습니다.
                  </td>
                </tr>
              ) : (
                students.map(student => (
                  <tr key={student.id}>
                    <td
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{getDisplayName(student)}</div>
                      {student.alias && (
                        <div
                          style={{
                            fontSize: 12,
                            color: '#6b7280',
                          }}
                        >
                          별칭: {student.alias}
                        </div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      {student.status || '-'}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      {student.schoolLevel || '-'}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      {student.admission_date
                        ? String(student.admission_date).slice(0, 10)
                        : '-'}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      {student.birth_date
                        ? String(student.birth_date).slice(0, 10)
                        : '-'}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #f3f4f6',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {student.memo || ''}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: 4,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => openEditModal(student)}
                          className="app-button"
                          style={{
                            flex: 1,
                            padding: '4px 6px',
                            fontSize: 12,
                            borderRadius: 4,
                            backgroundColor: '#ffffff',
                            color : '#374151',
                            cursor: 'pointer',
                          }}
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(student)}
                          className="app-button"
                          style={{
                            flex: 1,
                            padding: '4px 6px',
                            fontSize: 12,
                            borderRadius: 4,
                            border: '1px solid #fecaca',
                            backgroundColor: '#fee2e2',
                            color: '#b91c1c',
                            cursor: 'pointer',
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 수정 모달 */}
        {editingStudent && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: 640,
                maxHeight: '90vh',
                overflowY: 'auto',
                backgroundColor: '#ffffff',
                borderRadius: 12,
                boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
                padding: 16,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: 12,
                }}
              >
                <h2
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    margin: 0,
                  }}
                >
                  학생 정보 수정
                </h2>
                <button
                  type="button"
                  onClick={closeEditModal}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 18,
                    lineHeight: 1,
                    padding: 4,
                    marginTop: -4, // X 버튼을 조금 더 위로
                  }}
                >
                  ×
                </button>
              </div>

              <form onSubmit={handleEditSave}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  {/* 이름 */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <label style={{ fontSize: 12, color: '#4b5563' }}>이름</label>
                    <input
                      type="text"
                      name="name"
                      value={editForm.name}
                      onChange={handleEditChange}
                      className="app-input"
                      style={{ padding: '6px 8px', fontSize: 14 }}
                    />
                  </div>

                  {/* 별칭 */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <label style={{ fontSize: 12, color: '#4b5563' }}>별칭</label>
                    <input
                      type="text"
                      name="alias"
                      value={editForm.alias}
                      onChange={handleEditChange}
                      className="app-input"
                      style={{ padding: '6px 8px', fontSize: 14 }}
                    />
                  </div>

                  {/* 상태 */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <label style={{ fontSize: 12, color: '#4b5563' }}>상태</label>
                    <select
                      name="status"
                      value={editForm.status}
                      onChange={handleEditChange}
                      className="app-input"
                      style={{ padding: '6px 8px', fontSize: 14 }}
                    >
                      {STATUS_OPTIONS.map(opt => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 학교 단계 */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <label style={{ fontSize: 12, color: '#4b5563' }}>
                      학교 단계
                    </label>
                    <select
                      name="schoolLevel"
                      value={editForm.schoolLevel}
                      onChange={handleEditChange}
                      className="app-input"
                      style={{ padding: '6px 8px', fontSize: 14 }}
                    >
                      {SCHOOL_LEVEL_OPTIONS.map(opt => (
                        <option key={opt} value={opt}>
                          {opt || '선택 안 함'}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 입학일 */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <label style={{ fontSize: 12, color: '#4b5563' }}>입학일</label>
                    <input
                      type="date"
                      name="admission_date"
                      value={editForm.admission_date}
                      onChange={handleEditChange}
                      className="app-input"
                      style={{ padding: '6px 8px', fontSize: 14 }}
                    />
                  </div>

                  {/* 생년월일 */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <label style={{ fontSize: 12, color: '#4b5563' }}>생년월일</label>
                    <input
                      type="date"
                      name="birth_date"
                      value={editForm.birth_date}
                      onChange={handleEditChange}
                      className="app-input"
                      style={{ padding: '6px 8px', fontSize: 14 }}
                    />
                  </div>
                </div>

                {/* 메모 */}
                <div style={{ marginBottom: 8 }}>
                  <label
                    style={{
                      display: 'block',
                      marginBottom: 4,
                      fontSize: 12,
                      color: '#4b5563',
                    }}
                  >
                    메모
                  </label>
                  <textarea
                    name="memo"
                    value={editForm.memo}
                    onChange={handleEditChange}
                    rows={3}
                    className="app-input"
                    style={{
                      width: '100%',
                      fontSize: 14,
                      padding: 8,
                      resize: 'vertical',
                    }}
                  />
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 8,
                    marginTop: 12,
                  }}
                >
                  <button
                    type="button"
                    onClick={closeEditModal}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      backgroundColor: '#ffffff',
                      fontSize: 14,
                      cursor: 'pointer',
                    }}
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    disabled={savingEdit}
                    className="app-button"
                    style={{
                      padding: '6px 12px',
                      borderRadius: 6,
                      border: 'none',
                      backgroundColor: savingEdit ? '#9ca3af' : '#2563eb',
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
      </div>
    </Layout>
  )
}

export { StudentList }
