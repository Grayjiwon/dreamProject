// src/pages/Login.jsx
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

// 🔹 환경변수에서 백엔드 기본 URL 가져오기
const API_BASE = (
  import.meta.env.VITE_API_BAS ||
  import.meta.env.VITE_API_BASE ||
  'https://dreamproject-ia6s.onrender.com'
).replace(/\/+$/, '')

// 🔹 이 파일에서만 쓸 간단한 fetch 래퍼
async function apiRequest(path, options = {}) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = `${API_BASE}${normalizedPath}`

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  let body = null
  try {
    body = await res.json()
  } catch {
    // JSON 아니면 body는 null
  }

  if (!res.ok) {
    const error = new Error(body?.message || `Request failed: ${res.status}`)
    error.status = res.status
    error.body = body
    throw error
  }

  return body
}

// .env 에서 VITE_DEMO_MODE=true 로 두면 백엔드가 없어도 데모 로그인 허용
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true'

// 변경: SignupModal 컴포넌트 제거됨

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 변경: showSignup 상태 제거됨

  async function handleLogin(e) {
    e.preventDefault()
    setError('')

    if (!email || !password) {
      setError('이메일과 비밀번호를 입력해주세요.')
      return
    }

    try {
      setLoading(true)

      // ✅ Render 백엔드로 직접 로그인 요청
      const res = await apiRequest('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })

      const token = res?.token
      const user = res?.user

      if (!token || !user) {
        if (!DEMO_MODE) {
          throw new Error('로그인 정보를 확인할 수 없습니다.')
        }
        throw new Error('Invalid login response')
      }

      // 정상 로그인
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(user))
      navigate('/upload')
    } catch (err) {
      console.error(err)
      const msg = String(err?.message || '')
      const isBackendMissing =
        err?.status === 404 ||
        msg.includes('Not Found') ||
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError')

      // 데모 모드 + 백엔드 없음/404 → 데모 로그인
      if (DEMO_MODE && isBackendMissing) {
        const demoUser = {
          id: 'demo-user-id',
          email,
          display_name: email ? email.split('@')[0] : '데모 사용자',
          role: 'observer',
        }
        localStorage.setItem('token', 'demo-token')
        localStorage.setItem('user', JSON.stringify(demoUser))
        alert('데모 모드로 로그인했습니다.')
        navigate('/upload')
        return
      }

      setError(err?.body?.message || msg || '로그인 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  // ✅ Layout/TopNav 없이 로그인 전용 화면만 렌더링
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">꿈이자라는뜰</div>
        <h2>로그인</h2>
        <div className="subtitle">
          플랫폼에 접속하려면 계정 정보로 로그인하세요.
        </div>

        <form className="auth-form" onSubmit={handleLogin}>
          <label>이메일</label>
          <input
            type="email"
            value={email}
            placeholder="example@email.com"
            onChange={e => setEmail(e.target.value)}
          />

          <label>비밀번호</label>
          <input
            type="password"
            value={password}
            placeholder="비밀번호"
            onChange={e => setPassword(e.target.value)}
          />

          <div className="auth-actions">
            <button className="btn" type="submit" disabled={loading}>
              {loading ? '로그인 중...' : '로그인'}
            </button>
            {/* 변경: 회원가입 버튼 제거됨 */}
          </div>

          {error && (
            <div className="error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </form>
      </div>

      {/* 변경: SignupModal 렌더링 제거됨 */}
    </div>
  )
}