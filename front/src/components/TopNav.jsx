// src/components/TopNav.jsx
import React, { useEffect, useState, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

function NavTab({ to, icon, label, isActive }) {
  const navigate = useNavigate()

  return (
    <button
      type="button"
      className={isActive ? 'nav-tab active' : 'nav-tab'}
      onClick={() => navigate(to)}
    >
      {icon && <span className="nav-tab-icon">{icon}</span>}
      <span>{label}</span>
    </button>
  )
}

function ProfileMenu({ onClose, onSelectUsers, onSelectProfile, onSelectLogout }) {
  const ref = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        onClose()
      }
    }
    function handleEsc(e) {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [onClose])

  return (
    <div className="profile-menu" ref={ref}>
      <button
        type="button"
        className="profile-menu-item"
        onClick={onSelectUsers}
      >
        사용자
      </button>
      <button
        type="button"
        className="profile-menu-item"
        onClick={onSelectProfile}
      >
        프로필
      </button>
      <button
        type="button"
        className="profile-menu-item"
        onClick={onSelectLogout}
      >
        로그아웃
      </button>
    </div>
  )
}

function ProfileModal({ user, onClose, onSave }) {
  const [nickname, setNickname] = useState(
    user?.display_name || user?.name || '사용자'
  )
  const [newId, setNewId] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')

  function handleSubmit(e) {
    e.preventDefault()

    if (newPassword && newPassword !== newPasswordConfirm) {
      alert('새 비밀번호와 비밀번호 확인이 일치하지 않습니다.')
      return
    }

    const nextUser = {
      ...(user || {}),
      display_name: nickname || (user && (user.display_name || user.name)),
      name: nickname || (user && (user.display_name || user.name)),
      id: newId || user?.id,
      // 비밀번호는 데모라 실제 저장/전송은 하지 않음
    }

    onSave(nextUser)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card profile-settings-modal"
        onClick={e => e.stopPropagation()}
      >
        <button
          className="modal-close"
          aria-label="닫기"
          type="button"
          onClick={onClose}
        >
          ✕
        </button>

        <h3>프로필 설정</h3>
        <p className="muted">사용자 정보를 수정할 수 있습니다</p>

        <form className="modal-form" onSubmit={handleSubmit}>
          <label htmlFor="nickname">별명</label>
          <input
            id="nickname"
            value={nickname}
            onChange={e => setNickname(e.target.value)}
            placeholder="화면에 표시할 이름"
          />

          <p className="profile-settings-helper">ID/PW 재설정 (선택사항)</p>

          <label htmlFor="newId">새 아이디</label>
          <input
            id="newId"
            value={newId}
            onChange={e => setNewId(e.target.value)}
            placeholder="변경할 아이디 입력 (선택)"
          />

          <label htmlFor="newPassword">새 비밀번호</label>
          <input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="변경할 비밀번호 입력 (선택)"
          />

          <label htmlFor="newPasswordConfirm">비밀번호 확인</label>
          <input
            id="newPasswordConfirm"
            type="password"
            value={newPasswordConfirm}
            onChange={e => setNewPasswordConfirm(e.target.value)}
            placeholder="비밀번호 확인"
          />

          <div className="modal-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={onClose}
            >
              취소
            </button>
            <button type="submit" className="btn">
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function TopNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const path = location.pathname || '/'

  const [user, setUser] = useState(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isProfileOpen, setIsProfileOpen] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('user')
      if (raw) {
        setUser(JSON.parse(raw))
      }
    } catch (e) {
      console.error('사용자 정보를 불러오는 중 오류', e)
    }
  }, [])

  const isUpload = path.startsWith('/upload')
  const isDashboard = path === '/dashboard'
  const isReport = path === '/report'
  const isAdmin = path.startsWith('/students')

  function handleLogout() {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
    setIsMenuOpen(false)
    setIsProfileOpen(false)
    navigate('/login')
  }

  function handleSaveProfile(nextUser) {
    setUser(nextUser)
    try {
      localStorage.setItem('user', JSON.stringify(nextUser))
    } catch (e) {
      console.error('사용자 정보를 저장하는 중 오류', e)
    }
  }

  return (
    <>
      <header className="top-nav">
        <div className="top-nav-left">
          <div
            className="brand"
            role="button"
            tabIndex={0}
            onClick={() => navigate('/upload')}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') navigate('/upload')
            }}
            // 변경: 마우스 포인터 스타일 추가
            style={{ cursor: 'pointer' }}
          >
            꿈이자라는뜰
          </div>
        </div>

        <nav className="top-nav-center">
          <NavTab to="/upload" label="업로드" isActive={isUpload} />
          <NavTab to="/dashboard" label="대시보드" isActive={isDashboard} />
          <NavTab to="/report" label="리포트" isActive={isReport} />
          <NavTab to="/students" label="관리자" isActive={isAdmin} />
        </nav>

        {/* 변경: flex 스타일 추가 및 로그인 사용자 메시지 표시 */}
        <div className="top-nav-right" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {user && (
            <span style={{ fontSize: '14px', color: '#333' }}>
              {user.display_name || user.name || '사용자'}님이 로그인하셨습니다
            </span>
          )}
          <button
            className="avatar-btn"
            aria-label="내 계정"
            type="button"
            onClick={() => setIsMenuOpen(prev => !prev)}
          >
            <span role="img" aria-hidden="true">
              👤
            </span>
          </button>
        </div>
      </header>

      {isMenuOpen && (
        <ProfileMenu
          onClose={() => setIsMenuOpen(false)}
          onSelectUsers={() => {
            navigate('/students')
            setIsMenuOpen(false)
          }}
          onSelectProfile={() => {
            setIsMenuOpen(false)
            setIsProfileOpen(true)
          }}
          onSelectLogout={handleLogout}
        />
      )}

      {isProfileOpen && (
        <ProfileModal
          user={user}
          onClose={() => setIsProfileOpen(false)}
          onSave={handleSaveProfile}
        />
      )}
    </>
  )
}