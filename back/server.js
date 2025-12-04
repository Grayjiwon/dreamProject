// server.js
require('dotenv').config();
const express = require('express');
const { supabase } = require('./supabaseClient'); // 공용 클라이언트 불러오기
const cors = require('cors');
const { PDF_TXT_EXTRACTION_PROMPT } = require('./prompts');

// 🔹 업로드 + AI 분석용 추가 의존성
const multer = require('multer');
const path = require('path');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// 글로벌 에러 핸들러: 서버 크래시 방지 및 로그 출력
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// CORS 설정: Vite Dev 서버(5173) 등에서 오는 요청 허용
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://dream-project-theta.vercel.app',
  'https://creative-elf-1b8dcf.netlify.app',
];

// 환경변수 FRONTEND_ORIGINS에 쉼표로 여러 개 지정 가능
const envOrigins = (process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// 환경 변수와 기본값을 병합 (중복 제거)
const ALLOWED_ORIGINS = envOrigins.length 
  ? [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...envOrigins])] // 환경 변수와 기본값 병합
  : DEFAULT_ALLOWED_ORIGINS;
console.log('[CORS] Allowed origins:', ALLOWED_ORIGINS);

const corsOptions = {
  origin(origin, callback) {
    // 비브라우저/서버-서버 요청(origin 없음) 허용
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 600,
};

app.use(cors(corsOptions));
// 사전검사(Preflight) 요청 처리: 현재 요청에 대해 cors 헤더를 적용한 뒤 204 반환
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return cors(corsOptions)(req, res, () => res.sendStatus(204));
  }
  return next();
});
// Multer 등 업로드 중 발생하는 에러를 표준화해서 응답
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, message: '파일이 너무 큽니다. 최대 10MB까지 허용됩니다.' });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ ok: false, message: '업로드 처리 중 오류가 발생했습니다.', error: err.message });
  }
  return res.status(500).json({ ok: false, message: '서버 오류가 발생했습니다.', error: String(err) });
});

// 🔹 업로드용 multer & Gemini 클라이언트 설정
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
let genAI = null;
try {
  if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log(`[Gemini] 모델: ${GEMINI_MODEL}`);
  } else {
    console.warn('[Gemini] GEMINI_API_KEY 미설정: AI 분석 비활성화 상태로 서버 시작');
  }
} catch (e) {
  console.error('[Gemini] 클라이언트 초기화 에러:', e?.message || e);
  genAI = null;
}

// Gemini API 키/모델 헬스체크 엔드포인트
// GET /api/ai/health → { ok: boolean, message, model, details }
app.get('/api/ai/health', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(400).json({
      ok: false,
      message: 'GEMINI_API_KEY가 설정되지 않았습니다 (.env 확인).',
      model: GEMINI_MODEL,
    });
  }
  if (!genAI) {
    return res.status(500).json({
      ok: false,
      message: 'Gemini 클라이언트가 초기화되지 않았습니다.',
      model: GEMINI_MODEL,
    });
  }

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'ping' }],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16,
      },
    });
    const text = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.json({
      ok: true,
      message: 'Gemini 응답 성공',
      model: GEMINI_MODEL,
      details: text.slice(0, 200),
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[AI Health] 에러:', msg);
    // Google API 에러 객체에 statusCode/response가 있는 경우 포함
    const status = err?.status || err?.code || 500;
    const body = err?.response?.data || err?.response || null;
    return res.status(200).json({
      ok: false,
      message: 'Gemini 호출 실패',
      model: GEMINI_MODEL,
      error: msg,
      status,
      bodySnippet: body ? JSON.stringify(body).slice(0, 500) : null,
    });
  }
});

// 일반 헬스체크: 서버 살아있음 확인
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 🔹 로그인 API (POST /auth/login)
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {}

    if (!email || !password) {
      return res.status(400).json({ message: 'email과 password가 필요합니다.' })
    }

    // Supabase Auth로 이메일/비밀번호 로그인 시도
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error || !data?.session || !data?.user) {
      console.error('[AUTH] 로그인 실패:', error)
      return res
        .status(401)
        .json({ message: '이메일 또는 비밀번호가 올바르지 않습니다.' })
    }

    const { session, user } = data

    // 선택: user_profiles 테이블에서 display_name, role 가져오기
    let profile = null
    try {
      const { data: profileRow, error: profileErr } = await supabase
        .from('user_profiles')
        .select('id, display_name, role')
        .eq('id', user.id)
        .single()

      if (!profileErr && profileRow) {
        profile = profileRow
      }
    } catch (e) {
      console.error('[AUTH] user_profiles 조회 에러:', e)
    }

    const responseUser = {
      id: user.id,
      email: user.email,
      display_name:
        profile?.display_name ||
        user.user_metadata?.display_name ||
        (user.email ? user.email.split('@')[0] : ''),
      role: profile?.role || user.user_metadata?.role || 'observer',
    }

    // 프론트(Login.jsx)가 기대하는 형태로 응답
    // { token, user }
    return res.json({
      token: session.access_token,
      user: responseUser,
    })
  } catch (e) {
    console.error('POST /auth/login 에러:', e)
    return res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

// 기본 동작 확인용 엔드포인트
app.get('/', (req, res) => {
  res.send('Node + Supabase 서버 동작 중');
});

// DB 연결 테스트용 API
app.get('/api/users', async (req, res) => {
  const { data, error } = await supabase
    .from('user_profiles') // 나중에 students, log_entries 등으로 변경
    .select('*')
    .limit(20);

  if (error) {
    console.error('DB 에러:', error);
    return res.status(500).json({ message: 'DB Error', error });
  }

  res.json(data);
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`서버 실행됨: http://localhost:${port}`);
});

server.on('error', (err) => {
  console.error('[server.listen error]', err && err.stack ? err.stack : err);
});

// 프로세스가 즉시 종료되는 환경을 방지하기 위한 임시 keep-alive
// 일부 환경에서 이벤트 루프가 바로 종료되는 문제가 있어 stdin을 유지합니다.
try { process.stdin.resume(); } catch (_) {}
setInterval(() => {}, 60 * 1000);


// 1. students API
// 학생 목록 조회
// 예시: GET /api/students?status=재학중
app.get('/api/students', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from('students')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('students 목록 조회 에러:', error);
    return res.status(500).json({ message: 'DB Error', error });
  }

  res.json({
    count,
    items: data,
  });
});

// 학생 한 명 상세 조회
// GET /api/students/:id
app.get('/api/students/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    console.error('students 상세 조회 에러:', error);
    return res.status(404).json({ message: '학생을 찾을 수 없습니다.', error });
  }

  res.json(data);
});

// 학생 추가 코드
// POST /api/students
// body 예시:
// {
//   "name": "배짱",
//   "status": "재학중",
//   "admission_date": "2023-03-02",
//   "birth_date": "2010-01-01",
//   "notes": "테스트용"
// }

// 학생 생성
// POST /api/students
app.post('/api/students', async (req, res) => {
  try {
    const {
      name,
      status = '재학',        // 기존 status 컬럼 계속 사용
      admission_date,
      birth_date,
      notes,
      alias,
      school_level,
      memo,
    } = req.body || {};

    if (!name) {
      return res.status(400).json({ message: 'name 은 필수입니다.' });
    }

    const insertData = {
      name,
      status,
      admission_date: admission_date || null,
      birth_date: birth_date || null,
      notes: notes ?? null,
      alias: alias ?? null,
      school_level: school_level ?? null,
      memo: memo ?? null,
    };

    const { data, error } = await supabase
      .from('students')
      .insert([insertData])
      .select('*')
      .single();

    if (error) {
      console.error('학생 생성 에러:', error);
      return res.status(500).json({ message: 'DB Error', error });
    }

    return res.status(201).json(data);
  } catch (e) {
    console.error('POST /api/students 에러:', e);
    return res.status(500).json({ message: 'Server Error', error: e.toString() });
  }
});

// 학생 정보 수정
// PATCH /api/students/:id
// body에 온 필드만 선택적으로 업데이트
// 학생 수정
// PATCH /api/students/:id
app.patch('/api/students/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const {
      name,
      status,
      admission_date,
      birth_date,
      notes,
      alias,
      school_level,
      memo,
    } = req.body || {};

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (status !== undefined) updateData.status = status;
    if (admission_date !== undefined) updateData.admission_date = admission_date;
    if (birth_date !== undefined) updateData.birth_date = birth_date;
    if (notes !== undefined) updateData.notes = notes;
    if (alias !== undefined) updateData.alias = alias;
    if (school_level !== undefined) updateData.school_level = school_level;
    if (memo !== undefined) updateData.memo = memo;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: '수정할 필드가 없습니다.' });
    }

    const { data, error } = await supabase
      .from('students')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      console.error('학생 수정 에러:', error);
      return res.status(500).json({ message: 'DB Error', error });
    }

    return res.json(data);
  } catch (e) {
    console.error('PATCH /api/students/:id 에러:', e);
    return res.status(500).json({ message: 'Server Error', error: e.toString() });
  }
});

// 학생 삭제
// DELETE /api/students/:id
app.delete('/api/students/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('students')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('students 삭제 에러:', error);
    return res.status(500).json({ message: 'DB Error', error });
  }

  res.status(204).send();
});

// 2. log_entries API
// 일지 목록 조회
// 예시: GET /api/log_entries?student_id=...&from=2025-01-01&to=2025-01-31
app.get('/api/log_entries', async (req, res) => {
  const {
    student_id,
    from, // 시작 날짜 (log_date >= from)
    to,   // 끝 날짜 (log_date <= to)
    status,
    limit = 50,
    offset = 0,
  } = req.query;

  let query = supabase
    .from('log_entries')
    .select('*', { count: 'exact' })
    .order('log_date', { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (student_id) {
    query = query.eq('student_id', student_id);
  }
  if (from) {
    query = query.gte('log_date', from);
  }
  if (to) {
    query = query.lte('log_date', to);
  }
  if (status) {
    query = query.eq('status', status);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('log_entries 목록 조회 에러:', error);
    return res.status(500).json({ message: 'DB Error', error });
  }

  res.json({
    count,
    items: data,
  });
});

// 일지 한 건 상세 조회
// GET /api/log_entries/:id
app.get('/api/log_entries/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('log_entries')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    console.error('log_entries 상세 조회 에러:', error);
    return res.status(404).json({ message: '일지를 찾을 수 없습니다.', error });
  }

  res.json(data);
});

// 일지 추가 코드
// POST /api/log_entries
// body 예시:
// {
//   "log_date": "2025-11-19",
//   "student_id": "학생 uuid",
//   "observer_id": "교사 uuid (옵션)",
//   "emotion_tag": "기쁨",
//   "activity_tags": ["물주기", "정리"],
//   "log_content": "오늘은 ~~~",
//   "related_metrics": ["집중도:높음"],
//   "status": "success",
//   "source_file_path": null
// }
app.post('/api/log_entries', async (req, res) => {
  const body = req.body || {}; // req.body unifined 방지
  const {
    log_date,
    student_id,
    observer_id,
    emotion_tag,
    activity_tags,
    log_content,
    related_metrics,
    status = 'success',
    source_file_path,
  } = req.body;

  if (!log_date || !student_id) {
    return res.status(400).json({ message: 'log_date와 student_id는 필수입니다.' });
  }

  const { data, error } = await supabase
    .from('log_entries')
    .insert([
      {
        log_date,
        student_id,
        observer_id,
        emotion_tag,
        activity_tags,
        log_content,
        related_metrics,
        status,
        source_file_path,
      },
    ])
    .select()
    .single();

  if (error) {
    console.error('log_entries 추가 에러:', error);
    return res.status(500).json({ message: 'DB Error', error });
  }

  res.status(201).json(data);
});

// 일지 수정
// PATCH /api/log_entries/:id
app.patch('/api/log_entries/:id', async (req, res) => {
  const { id } = req.params;
  const {
    log_date,
    student_id,
    observer_id,
    emotion_tag,
    activity_tags,
    log_content,
    related_metrics,
    status,
    source_file_path,
  } = req.body;

  const updateData = {};
  if (log_date !== undefined) updateData.log_date = log_date;
  if (student_id !== undefined) updateData.student_id = student_id;
  if (observer_id !== undefined) updateData.observer_id = observer_id;
  if (emotion_tag !== undefined) updateData.emotion_tag = emotion_tag;
  if (activity_tags !== undefined) updateData.activity_tags = activity_tags;
  if (log_content !== undefined) updateData.log_content = log_content;
  if (related_metrics !== undefined) updateData.related_metrics = related_metrics;
  if (status !== undefined) updateData.status = status;
  if (source_file_path !== undefined) updateData.source_file_path = source_file_path;

  const { data, error } = await supabase
    .from('log_entries')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('log_entries 수정 에러:', error);
    return res.status(500).json({ message: 'DB Error', error });
  }

  res.json(data);
});

// 일지 삭제
// DELETE /api/log_entries/:id
app.delete('/api/log_entries/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('log_entries')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('log_entries 삭제 에러:', error);
    return res.status(500).json({ message: 'DB Error', error });
  }

  res.status(204).send();
});

// 3. emotion tags API (Supabase 테이블: tags)
// GET /rest/v1/tags?select=*
app.get(['/rest/v1/tags'], async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tags')
      .select('*')
      .order('name', { ascending: true })

    if (error) {
      console.error('tags 조회 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    return res.json(data || [])
  } catch (e) {
    console.error('GET /rest/v1/tags 에러:', e)
    return res.status(500).json({ message: 'Server Error', error: e.toString() })
  }
})

// POST /rest/v1/tags  body: { name: "감정" }
// 헤더 Prefer: return=representation 지원
app.post(['/rest/v1/tags'], async (req, res) => {
  try {
    const { name } = req.body || {}
    const label = (name || '').trim()
    if (!label) {
      return res.status(400).json({ message: 'name 필드가 필요합니다.' })
    }

    const { data, error } = await supabase
      .from('tags')
      .insert([{ name: label }])
      .select('*')
      .single()

    if (error) {
      console.error('tags 추가 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    const prefer = String(req.headers['prefer'] || '').toLowerCase()
    if (prefer.includes('return=representation')) {
      return res.status(201).json(data)
    }
    return res.status(201).json({ ok: true })
  } catch (e) {
    console.error('POST /rest/v1/tags 에러:', e)
    return res.status(500).json({ message: 'Server Error', error: e.toString() })
  }
})

function splitRawTextByDateBlocks(rawText) {
  if (!rawText) return [];

  const lines = rawText.split(/\r?\n/);
  const blocks = [];
  let currentDate = null;
  let currentLines = [];

  for (const line of lines) {
    // "2025-03-10" 이런 형식 찾기
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      // 이전 날짜 블록 저장
      if (currentDate && currentLines.length > 0) {
        blocks.push({
          date: currentDate,
          text: currentLines.join('\n').trim(),
        });
      }
      currentDate = dateMatch[1]; // "2025-03-10"
      const rest = line.replace(currentDate, '').trim();
      currentLines = rest ? [rest] : [];
    } else {
      currentLines.push(line);
    }
  }

  // 마지막 블록 저장
  if (currentDate && currentLines.length > 0) {
    blocks.push({
      date: currentDate,
      text: currentLines.join('\n').trim(),
    });
  }

  return blocks;
}

// =======================
// 🔻 여기부터 업로드 + AI 분석 관련 추가 코드
// =======================

// JSON 응답에서 records 구조 안전하게 파싱
function parseJsonFromText(text) {
  if (!text) return null;

  // 1) 전체를 순수 JSON으로 먼저 시도
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) {
      return { records: obj };
    }
    if (obj && typeof obj === 'object') {
      if (Array.isArray(obj.records)) return obj;
      const alt = obj.data || obj.items || obj.logs || null;
      if (Array.isArray(alt)) return { records: alt };
      return obj;
    }
  } catch (e) {
    console.warn('parseJsonFromText: raw JSON parse 실패:', e);
  }

  // 2) ```json ... ``` 코드블록에 담긴 경우 파싱
  const codeBlockMatch = text.match(/```json([\s\S]*?)```/i);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    try {
      const obj = JSON.parse(inner);
      if (Array.isArray(obj)) {
        return { records: obj };
      }
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj.records)) return obj;
        const alt = obj.data || obj.items || obj.logs || null;
        if (Array.isArray(alt)) return { records: alt };
        return obj;
      }
    } catch (e) {
      console.warn('parseJsonFromText: code block JSON parse 실패:', e);
    }
  }

  // 3) 텍스트에서 첫 { ... } 블록만 잘라 JSON 시도
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const possible = text.slice(firstBrace, lastBrace + 1);
    try {
      const obj = JSON.parse(possible);
      if (Array.isArray(obj)) {
        return { records: obj };
      }
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj.records)) return obj;
        const alt = obj.data || obj.items || obj.logs || null;
        if (Array.isArray(alt)) return { records: alt };
        return obj;
      }
    } catch (e) {
      console.warn('parseJsonFromText: brace range JSON parse 실패:', e);
    }
  }

  return null;
}

// PDF / TXT에서 텍스트 추출
async function extractPlainTextFromFile(file) {
  if (!file) return null;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  if (ext === '.pdf' || mime === 'application/pdf') {
    const data = await pdfParse(file.buffer);
    return (data.text || '').trim();
  }

  return file.buffer.toString('utf8');
}

// "10:00-10:30" / "30분" 등 → 대략적인 분 단위 시간
function estimateDurationMinutesFromActivityTime(activityTime) {
  if (!activityTime) return null;
  const text = String(activityTime).trim();

  // "30분", "약 45분"
  const m1 = text.match(/(\d+)\s*분/);
  if (m1) {
    const v = parseInt(m1[1], 10);
    if (!Number.isNaN(v)) return v;
  }

  // "10:00-10:30", "10:00 ~ 11:15"
  const m2 = text.match(/(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})/);
  if (m2) {
    const [_, h1, m11, h2, m22] = m2;
    const start = parseInt(h1, 10) * 60 + parseInt(m11, 10);
    const end = parseInt(h2, 10) * 60 + parseInt(m22, 10);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
      return end - start;
    }
  }

  return null;
}

// "홍길동(길동이)" → { name: '홍길동', alias: '길동이' }
function normalizeNameAndAlias(studentNameRaw, studentAliasRaw) {
  let name = (studentNameRaw || '').trim();
  let alias = (studentAliasRaw || '').trim();

  if (!name) return { name: '', alias: '' };

  const bracketMatch = name.match(/^(.+?)\s*\((.+?)\)\s*$/);
  if (bracketMatch) {
    const realName = bracketMatch[1].trim();
    const inBracket = bracketMatch[2].trim();
    if (realName) name = realName;
    if (!alias && inBracket) alias = inBracket;
  }

  return { name, alias };
}

// 날짜 문자열 → YYYY-MM-DD
function normalizeDate(dateStr) {
  if (!dateStr) {
    return new Date().toISOString().slice(0, 10);
  }
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

// (name, alias) → 고유 키
function makeStudentKey(name, alias) {
  return `${(name || '').trim()}|||${(alias || '').trim()}`;
}

/**
 * 🔸 runAutoExtractionForUpload
 * - 업로드 1건에 대해 rawText를 Gemini에 보내서 records JSON을 받고
 *   students / log_entries / ingest_uploads 를 업데이트한다.
 *
 * records 스키마:
 * {
 *   "records": [
 *     {
 *       "date": "YYYY-MM-DD",
 *       "student_name": "홍길동",
 *       "student_alias": "길동이",
 *       "activities": [
 *         {
 *           "activity_name": "파종",
 *           "activity_time": "10:00-10:30",
 *           "activity_emotion": ["즐거움","집중"]
 *         }
 *       ],
 *       "note": "이 학생에 대한 특이사항/요약"
 *     }
 *   ]
 * }
 */
async function runAutoExtractionForUpload(uploadRow, rawText) {
  if (!uploadRow || !uploadRow.id || !rawText) {
    console.log('[AUTO AI] 잘못된 인자, 실행하지 않음.');
    return;
  }

  try {
    // 0) 최신 ingest_uploads 상태 다시 확인 (이미 처리된 업로드 중복 처리 방지)
    const { data: latestUpload, error: latestErr } = await supabase
      .from('ingest_uploads')
      .select('id, file_name, status')
      .eq('id', uploadRow.id)
      .single();

    if (latestErr) {
      console.error('[AUTO AI] ingest_uploads 최신 상태 조회 에러:', latestErr);
    }

    const effectiveUpload = latestUpload || uploadRow;

    // 이미 success + log_entries 존재하면 재분석 스킵
    if (effectiveUpload.status === 'success') {
      const { data: existingLogs, error: logsErr } = await supabase
        .from('log_entries')
        .select('id')
        .eq('source_file_path', effectiveUpload.file_name)
        .limit(1);

      if (!logsErr && Array.isArray(existingLogs) && existingLogs.length > 0) {
        console.log(
          `[AUTO AI] 업로드 ${effectiveUpload.id} 는 이미 success + log_entries 존재. 재분석 생략.`,
        );
        return;
      }
    }

    console.log(
      `[AUTO AI] 업로드 ${effectiveUpload.id} 자동 분석 시작 (파일명: ${effectiveUpload.file_name})`,
    );

    // 1) raw_text 로그 + 길이 제한 (너무 긴 경우 토큰 초과 방지)
    const RAW_MAX_CHARS = 8000;
    let safeRaw = rawText || '';
    const _len = safeRaw.length;
    const _head = safeRaw.slice(0, 300);
    console.log(`[AUTO AI] raw_text length=${_len}`);
    console.log('[AUTO AI] raw_text head sample:\n' + _head);

    // ======= 🔽 여기부터 추가 (날짜별 원문 저장) 🔽 =======
    try {
      const dateBlocks = splitRawTextByDateBlocks(rawText);

      if (dateBlocks.length > 0) {
        const dailyRows = dateBlocks.map(b => ({
          log_date: normalizeDate(b.date),          // "2025-03-10" → Date
          source_file_path: effectiveUpload.file_name,
          raw_text: b.text,                         // 해당 날짜의 원문 전체
        }));

        const { error: dailyErr } = await supabase
          .from('daily_raw_logs')
          .insert(dailyRows);

        if (dailyErr) {
          console.error(
            '[AUTO AI] daily_raw_logs insert 에러:',
            dailyErr,
          );
        } else {
          console.log(
            `[AUTO AI] daily_raw_logs 저장 완료. 개수=${dailyRows.length}`,
          );
        }
      } else {
        console.log(
          '[AUTO AI] splitRawTextByDateBlocks 결과가 비어 있습니다. 날짜 패턴(YYYY-MM-DD)을 찾지 못했을 수 있습니다.',
        );
      }
    } catch (e) {
      console.error(
        '[AUTO AI] 날짜별 원문 저장 중 예외 발생:',
        e,
      );
    }
    // ======= 🔼 여기까지 추가 (날짜별 원문 저장) 🔼 =======

    if (safeRaw.length > RAW_MAX_CHARS) {
      console.log(
        `[AUTO AI] raw_text가 너무 길어 앞 ${RAW_MAX_CHARS}자만 사용합니다.`,
      );
      safeRaw = safeRaw.slice(0, RAW_MAX_CHARS);
    }

    // 2) 프롬프트 구성
    const extractionPrompt = PDF_TXT_EXTRACTION_PROMPT.replace(
      '{raw_text}',
      safeRaw,
    ).trim();

    if (!genAI) {
      console.warn('[AUTO AI] Gemini 비활성화(GEMINI_API_KEY 없음). 분석 생략.');
      await supabase
        .from('ingest_uploads')
        .update({
          status: 'error',
          error: 'AI 비활성화: GEMINI_API_KEY 미설정으로 분석 불가',
          updated_at: new Date().toISOString(),
        })
        .eq('id', effectiveUpload.id);
      return;
    }

    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    console.log('[AUTO AI] Gemini 호출 시작. model=', GEMINI_MODEL);

    // 3) Gemini 호출 (JSON-only는 프롬프트로 강하게 요구, responseMimeType는 제거)
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: extractionPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        // maxOutputTokens 명시 안 함 → 기본값 사용
        // responseMimeType: 'application/json', // JSON 모드는 일단 사용하지 않음
      },
    });

    // 4) 응답에서 텍스트 안전하게 꺼내기
    const response = result?.response;
    let text = '';

    try {
      if (response && typeof response.text === 'function') {
        const maybe = response.text();
        if (typeof maybe === 'string') {
          text = maybe;
        } else if (maybe && typeof maybe.then === 'function') {
          text = await maybe; // Promise<string> 인 경우
        }
      }
    } catch (e) {
      console.warn('[AUTO AI] response.text() 호출 중 에러:', e);
    }

    // fallback: candidates[0].content.parts[*].text 에 JSON이 들어있는 경우
    if (
      !text &&
      Array.isArray(response?.candidates) &&
      response.candidates.length > 0
    ) {
      try {
        const parts = response.candidates[0].content?.parts || [];
        text = parts
          .map(p =>
            typeof p === 'string'
              ? p
              : typeof p.text === 'string'
              ? p.text
              : '',
          )
          .join('')
          .trim();
        if (text) {
          console.log(
            '[AUTO AI] candidates[0].content.parts 에서 텍스트 fallback 사용. length=',
            text.length,
          );
        } else {
          console.log(
            '[AUTO AI] candidates[0].content.parts 에 text 필드가 없습니다.',
          );
        }
      } catch (e) {
        console.warn(
          '[AUTO AI] candidates[0].content.parts fallback 파싱 실패:',
          e,
        );
      }
    }

    const rawLen = (text || '').length;
    const rawHeadResp = (text || '').slice(0, 500);
    console.log(`[AUTO AI] model raw response length=${rawLen}`);
    if (rawHeadResp) {
      console.log('[AUTO AI] model raw response head:\n' + rawHeadResp);
    }

    // 4-1) 응답이 완전히 비어있는 경우 (MAX_TOKENS 등)
    if (!rawLen) {
      console.warn(
        '[AUTO AI] text가 비어 있음. usageMetadata 등 전체 응답 덤프(앞 2000자):',
      );
      try {
        console.warn(
          JSON.stringify(result, null, 2).slice(0, 2000),
        );
      } catch (e) {
        console.warn('[AUTO AI] result JSON.stringify 중 에러:', e);
      }

      await supabase
        .from('ingest_uploads')
        .update({
          status: 'error',
          error:
            'AI 응답이 비어 있습니다. (MAX_TOKENS 또는 안전 필터 등으로 실패 가능성, 서버 로그 참고)',
          updated_at: new Date().toISOString(),
        })
        .eq('id', effectiveUpload.id);
      return;
    }

    // 5) JSON 파싱 시도
    const parsed = parseJsonFromText(text);

    if (!parsed || !Array.isArray(parsed.records)) {
      console.warn('[AUTO AI] records 배열이 없는 응답. parsed=', parsed);
      const errSnippet = (text || '').slice(0, 300);
      await supabase
        .from('ingest_uploads')
        .update({
          status: 'error',
          error:
            'AI 분석 결과에 records 배열이 없습니다. 응답 선두: ' +
            errSnippet,
          updated_at: new Date().toISOString(),
        })
        .eq('id', effectiveUpload.id);
      return;
    }

    const records = parsed.records || [];
    console.log(
      `[AUTO AI] 업로드 ${effectiveUpload.id} records 개수:`,
      records.length,
    );

    if (records.length === 0) {
      await supabase
        .from('ingest_uploads')
        .update({
          status: 'success',
          progress: 100,
          updated_at: new Date().toISOString(),
        })
        .eq('id', effectiveUpload.id);
      return;
    }

    // --------- (1) (name, alias) 쌍 수집 ---------
    const nameAliasList = [];
    const nameSet = new Set();

    for (const rec of records) {
      const { name, alias } = normalizeNameAndAlias(
        rec.student_name,
        rec.student_alias,
      );
      if (!name) continue;
      const key = makeStudentKey(name, alias);
      if (!nameSet.has(key)) {
        nameSet.add(key);
        nameAliasList.push({ name, alias });
      }
    }

    // --------- (2) 기존 students 조회 ---------
    let existingStudents = [];
    if (nameAliasList.length > 0) {
      const distinctNames = [
        ...new Set(nameAliasList.map(p => p.name).filter(Boolean)),
      ];
      if (distinctNames.length > 0) {
        const { data: sData, error: sErr } = await supabase
          .from('students')
          .select('id, name, alias')
          .in('name', distinctNames);

        if (sErr) {
          console.error('[AUTO AI] students 기존 조회 에러:', sErr);
        } else if (Array.isArray(sData)) {
          existingStudents = sData;
        }
      }
    }

    const studentMap = {};

    // (2-1) alias까지 있는 경우 우선 매칭
    for (const pair of nameAliasList) {
      const { name, alias } = pair;
      const key = makeStudentKey(name, alias);

      if (alias) {
        const candidates = existingStudents.filter(
          s =>
            (s.name || '').trim() === name &&
            (s.alias || '').trim() === alias,
        );
        if (candidates.length === 1) {
          studentMap[key] = candidates[0].id;
        }
        continue;
      }

      const candidates = existingStudents.filter(
        s => (s.name || '').trim() === name,
      );
      if (candidates.length === 1) {
        studentMap[key] = candidates[0].id;
      }
    }

    console.log('[AUTO AI] studentMap:', studentMap);

    // --------- (3) log_entries row 생성 ---------
const logRows = [];

for (const rec of records) {
  const normalizedDate = normalizeDate(rec.date);
  const { name, alias } = normalizeNameAndAlias(
    rec.student_name,
    rec.student_alias,
  );
  const key = makeStudentKey(name, alias);
  const studentId = studentMap[key] || null;

  // log_entries.student_id 는 NOT NULL 이라서, 학생 ID 없으면 스킵
  if (!studentId) {
    console.warn(
      '[AUTO AI] student_id 없음. 해당 record는 log_entries에 저장하지 않음. record=',
      rec,
    );
    continue;
  }

  // 기본 베이스: log_entries 스키마 기준
  const base = {
    student_id: studentId,
    log_date: normalizedDate, // ← log_entries.log_date
    source_file_path: effectiveUpload.file_name,
    status: 'success',        // 기본값이 있긴 하지만 명시적으로 넣어줌
  };

  // rec.activities 배열이 있으면 그걸 사용, 없으면 1개짜리 기본 활동 생성
  let activities = rec.activities || [];
  if (!Array.isArray(activities) || activities.length === 0) {
    activities = [
      {
        activity_name: rec.activity_title || '기록된 활동',
        activity_type: rec.activity_type || null,
        activity_time: rec.minutes || null,
        activity_emotion: rec.emotions || [],
      },
    ];
  }

  for (const act of activities) {
    // 감정 리스트 결정
    const emotionList =
      Array.isArray(act.activity_emotion) &&
      act.activity_emotion.length > 0
        ? act.activity_emotion
        : Array.isArray(rec.emotions)
        ? rec.emotions
        : [];

    // emotion_tag: 문자열 하나로 저장 (예: "긴장, 설렘")
    const emotionTag =
      emotionList && emotionList.length > 0
        ? emotionList.join(', ')
        : null;

    // activity_tags: 활동 유형/이름을 배열로 저장
    const activityTags = [];
    if (act.activity_type) {
      activityTags.push(act.activity_type);
    } else if (rec.activity_type) {
      activityTags.push(rec.activity_type);
    } else if (act.activity_name || rec.activity_title) {
      // 타입이 없으면 이름이라도 태그로 넣어둠
      activityTags.push(
        act.activity_name || rec.activity_title || '활동',
      );
    }

    // 활동 이름 / 시간 / 감정 / 메모를 합쳐서 log_content에 저장
    const activityName =
      act.activity_name || rec.activity_title || '활동';
    const timeText =
      act.activity_time ||
      (rec.minutes ? `${rec.minutes}분` : null);
    const noteText =
      rec.teacher_notes || rec.note || null;

    let logContent = `[${activityName}]`;
    if (timeText) {
      logContent += ` 시간: ${timeText}`;
    }
    if (emotionTag) {
      logContent += ` / 감정: ${emotionTag}`;
    }
    if (noteText) {
      logContent += ` / 메모: ${noteText}`;
    }

    logRows.push({
      ...base,
      emotion_tag: emotionTag,
      activity_tags:
        activityTags.length > 0 ? activityTags : null, // ARRAY 컬럼
      log_content: logContent,
      related_metrics: null, // 나중에 지표 쓰고 싶으면 여기 확장
    });
  }
}

console.log(
  `[AUTO AI] 업로드 ${effectiveUpload.id} log_rows 생성 완료. 개수=${logRows.length}`,
);

    // --------- (4) 새 학생(students) 생성 ---------
    const newStudentsToInsert = nameAliasList.filter(pair => {
      const key = makeStudentKey(pair.name, pair.alias);
      return !studentMap[key];
    });

    if (newStudentsToInsert.length > 0) {
      const now = new Date().toISOString();
      const toInsert = newStudentsToInsert.map(ns => ({
        name: ns.name,
        alias: ns.alias || null,
        created_at: now,
        updated_at: now,
      }));

      console.log(
        `[AUTO AI] 새 student insert 예정 개수=${toInsert.length}`,
      );

      const { data: insertedStudents, error: insErr } = await supabase
        .from('students')
        .insert(toInsert)
        .select('id, name, alias');

      if (insErr) {
        console.error('[AUTO AI] students insert 에러:', insErr);
      } else if (Array.isArray(insertedStudents)) {
        for (const s of insertedStudents) {
          const key = makeStudentKey(s.name, s.alias);
          studentMap[key] = s.id;
        }
        console.log(
          '[AUTO AI] students insert 완료. studentMap 갱신:',
          studentMap,
        );
      }
    }

    // --------- (5) 기존 log_entries 삭제 후 새로 insert ---------
    const { error: delErr } = await supabase
      .from('log_entries')
      .delete()
      .eq('source_file_path', effectiveUpload.file_name);

    if (delErr) {
      console.error('[AUTO AI] 기존 log_entries 삭제 에러:', delErr);
    }

    const { data: insertedLogs, error: insErr } = await supabase
      .from('log_entries')
      .insert(logRows)
      .select('id, student_id');

    if (insErr) {
      console.error('[AUTO AI] log_entries insert 에러:', insErr);
      await supabase
        .from('ingest_uploads')
        .update({
          status: 'error',
          error: 'log_entries 저장 실패',
          updated_at: new Date().toISOString(),
        })
        .eq('id', effectiveUpload.id);
      return;
    }

    const firstStudentId =
      insertedLogs && insertedLogs[0] ? insertedLogs[0].student_id : null;

    await supabase
      .from('ingest_uploads')
      .update({
        status: 'success',
        progress: 100,
        student_id: firstStudentId,
        updated_at: new Date().toISOString(),
        error: null,
      })
      .eq('id', effectiveUpload.id);

    console.log(
      `[AUTO AI] 업로드 ${effectiveUpload.id} 자동 분석 완료. log_rows=${logRows.length}`,
    );
  } catch (e) {
    console.error('[AUTO AI] runAutoExtractionForUpload 예외:', e);
    try {
      await supabase
        .from('ingest_uploads')
        .update({
          status: 'error',
          error: '자동 AI 분석 중 예외 발생: ' + e.toString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', uploadRow.id);
    } catch (e2) {
      console.error(
        '[AUTO AI] ingest_uploads 에러 상태 업데이트 실패:',
        e2,
      );
    }
  }
}

// =======================
// 🔻 업로드 라우트들
// =======================

/**
 * POST /uploads, /api/uploads
 * - ingest_uploads 에 메타데이터 저장
 * - 파일에서 raw_text 추출하여 ingest_uploads.raw_text 업데이트
 * - 그 직후 runAutoExtractionForUpload(uploadRow, rawText) 1회 호출
 */
app.post(
  ['/uploads', '/api/uploads'],
  upload.single('file'),
  async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ message: '파일이 필요합니다.' });
      }

      const originalName = Buffer.from(
        file.originalname,
        'latin1',
      ).toString('utf8');

      const storageKey = `uploads/${Date.now()}-${originalName}`;
      const now = new Date().toISOString();

      const uploadedBy =
        (req.body &&
          (req.body.uploaded_by ||
            req.body.user_id ||
            req.body.uploader_id)) ||
        null;

      const { data: uploadRow, error } = await supabase
        .from('ingest_uploads')
        .insert([
          {
            file_name: originalName,
            storage_key: storageKey,
            student_id: null,
            uploaded_by: uploadedBy,
            status: 'queued',
            progress: 0,
            error: null,
            created_at: now,
            updated_at: now,
          },
        ])
        .select()
        .single();

      if (error) {
        console.error('ingest_uploads insert 에러:', error);
        return res.status(500).json({ message: 'DB Error', error });
      }

      let rawText = null;
      try {
        rawText = await extractPlainTextFromFile(file);
      } catch (e) {
        console.error('extractPlainTextFromFile 에러:', e);
      }

      if (rawText) {
        try {
          const { error: upErr } = await supabase
            .from('ingest_uploads')
            .update({
              raw_text: rawText,
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadRow.id);

          if (upErr) {
            console.error('ingest_uploads raw_text 업데이트 에러:', upErr);
          } else {
            uploadRow.raw_text = rawText;
          }
        } catch (e) {
          console.error('ingest_uploads raw_text 업데이트 예외:', e);
        }

        // 🔸 업로드 직후 자동 AI 분석 (다른 라우트에서는 호출 X)
        runAutoExtractionForUpload(uploadRow, rawText).catch(err => {
          console.error(
            `[AUTO AI] 업로드 ${uploadRow.id} 자동 분석 실패:`,
            err,
          );
        });
      }

      return res.status(201).json(uploadRow);
    } catch (e) {
      console.error('POST /uploads 에러:', e);
      return res
        .status(500)
        .json({ message: 'Upload Error', error: e.toString() });
    }
  },
);

/**
 * GET /uploads, /api/uploads
 * - ingest_uploads 목록 + 대표 학생 이름 + 업로더 이름
 */
app.get(['/uploads', '/api/uploads'], async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ingest_uploads')
      .select(
        'id, file_name, status, progress, error, created_at, student_id, uploaded_by',
      )
      .order('created_at', { ascending: false });

    if (error) {
      console.error('ingest_uploads 목록 조회 에러:', error);
      return res.status(500).json({ message: 'DB Error', error });
    }

    const uploadsRaw = data || [];

    const studentIds = [
      ...new Set(uploadsRaw.map(u => u.student_id).filter(Boolean)),
    ];
    const uploaderIds = [
      ...new Set(uploadsRaw.map(u => u.uploaded_by).filter(Boolean)),
    ];

    let studentsById = {};
    if (studentIds.length > 0) {
      const { data: students, error: sErr } = await supabase
        .from('students')
        .select('id, name')
        .in('id', studentIds);

      if (sErr) {
        console.error('students 조회 에러:', sErr);
      } else if (students) {
        studentsById = Object.fromEntries(
          students.map(s => [s.id, s.name]),
        );
      }
    }

    let uploaderById = {};
    if (uploaderIds.length > 0) {
      const { data: profiles, error: pErr } = await supabase
        .from('user_profiles')
        .select('id, display_name')
        .in('id', uploaderIds);

      if (pErr) {
        console.error('user_profiles 조회 에러:', pErr);
      } else if (profiles) {
        uploaderById = Object.fromEntries(
          profiles.map(p => [p.id, p.display_name || '']),
        );
      }
    }

    const uploads = uploadsRaw.map(u => ({
      id: u.id,
      file_name: u.file_name,
      status: u.status,
      progress: u.progress,
      error: u.error,
      created_at: u.created_at,
      uploaded_at: u.created_at,
      uploaded_by: u.uploaded_by,
      uploader_name: uploaderById[u.uploaded_by] || null,
      student_id: u.student_id,
      student_name: studentsById[u.student_id] || null,
    }));

    res.json(uploads);
  } catch (e) {
    console.error('GET /uploads 에러:', e);
    res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() });
  }
});

/**
 * GET /uploads/:id, /api/uploads/:id
 * - ingest_uploads 1건 + 해당 파일에서 생성된 log_entries + 학생 정보(alias 포함)
 */
app.get(['/uploads/:id', '/api/uploads/:id'], async (req, res) => {
  const { id } = req.params;

  try {
    const { data: upload, error: uploadErr } = await supabase
      .from('ingest_uploads')
      .select('*')
      .eq('id', id)
      .single();

    if (uploadErr || !upload) {
      console.error('uploads 단일 조회 에러:', uploadErr);
      return res
        .status(404)
        .json({ message: '업로드를 찾을 수 없습니다.' });
    }

    const { data: logs, error: logsErr } = await supabase
      .from('log_entries')
      .select(
        'id, log_date, student_id, emotion_tag, activity_tags, log_content, related_metrics, source_file_path, student:students(name,alias)',
      )
      .eq('source_file_path', upload.file_name)
      .order('log_date', { ascending: true });

    if (logsErr) {
      console.error('log_entries 조회 에러 (uploads/:id):', logsErr);
    }

    const logEntriesRaw = logs || [];

    let rawText = upload.raw_text || null;
    if (!rawText && logEntriesRaw.length > 0) {
      rawText = logEntriesRaw[0].log_content || null;
    }

    const logEntries = logEntriesRaw.map(entry => {
      const rmRaw = entry.related_metrics;
      const baseAnalysis =
        Array.isArray(rmRaw) && rmRaw.length > 0
          ? rmRaw[0] || {}
          : rmRaw || entry.analysis || {};

      const studentName =
        entry.student_name ||
        (entry.student && entry.student.name) ||
        null;

      const studentAlias =
        entry.student_alias ||
        (entry.student && entry.student.alias) ||
        null;

      const emotionTags = Array.isArray(baseAnalysis.emotionTags)
        ? baseAnalysis.emotionTags
        : Array.isArray(baseAnalysis.emotion_tags)
        ? baseAnalysis.emotion_tags
        : [];

      const emotionSummary =
        baseAnalysis.emotionSummary ||
        baseAnalysis.emotion_summary ||
        entry.emotion_tag ||
        (emotionTags.length > 0 ? emotionTags[0] : null);

      const activities = Array.isArray(baseAnalysis.activities)
        ? baseAnalysis.activities
        : [];

      const note = baseAnalysis.note || '';

      const durationMinutes =
        typeof baseAnalysis.duration_minutes === 'number'
          ? baseAnalysis.duration_minutes
          : typeof baseAnalysis.durationMinutes === 'number'
          ? baseAnalysis.durationMinutes
          : null;

      const analysis = {
        ...baseAnalysis,
        activities,
        note,
        emotionTags,
        emotionSummary,
        duration_minutes: durationMinutes,
      };

      return {
        ...entry,
        student_name: studentName,
        student_alias: studentAlias,
        analysis,
      };
    });

    const studentMap = {};
    for (const entry of logEntries) {
      const sid = entry.student_id;
      if (!sid) continue;
      const name =
        entry.student_name ||
        (entry.student && entry.student.name) ||
        '';
      if (!name) continue;
      const alias =
        entry.student_alias ||
        (entry.student && entry.student.alias) ||
        null;

      if (!studentMap[sid]) {
        studentMap[sid] = {
          id: sid,
          name,
          alias,
          label: alias ? `${name}(${alias})` : name,
        };
      }
    }
    const students = Object.values(studentMap);

    return res.json({
      ...upload,
      raw_text: rawText,
      log_entries: logEntries,
      students,
    });
  } catch (e) {
    console.error('GET /uploads/:id 에러:', e);
    return res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() });
  }
});

// --------------------------------------------------
// 업로드별 "활동 유형 상세 집계" API
// GET /activity_types?upload_id=...
// --------------------------------------------------
app.get('/activity_types', async (req, res) => {
  try {
    const { upload_id } = req.query;

    if (!upload_id) {
      return res.status(400).json({ message: 'upload_id 쿼리 파라미터가 필요합니다.' });
    }

    // 1) 업로드 행에서 details(JSONB) 읽기
    const { data: upload, error: uploadError } = await supabase
      .from('ingest_uploads')
      .select('id, details')
      .eq('id', upload_id)
      .single();

    if (uploadError || !upload) {
      console.error('ingest_uploads 조회 에러:', uploadError);
      return res.status(404).json({ message: '업로드를 찾을 수 없습니다.', error: uploadError });
    }

    const details = upload.details || {};
    const datesArray = Array.isArray(details.dates) ? details.dates : [];

    const records = [];
    const countByType = {};

    // 활동명으로 대분류 추론
    function guessActivityType(name) {
      const n = (name || '').toString();
      if (n.includes('수확')) return '수확';
      if (n.includes('파종') || n.includes('심기') || n.includes('모종')) return '파종';
      if (n.includes('관리') || n.includes('정리') || n.includes('잡초') || n.includes('물')) return '관리';
      if (n.includes('관찰') || n.includes('기록')) return '관찰';
      return '기타';
    }

    // 2) details JSON을 날짜/학생/활동 단위로 펼쳐서 레코드 생성
    for (const d of datesArray) {
      const date = d.date || d.log_date || null;
      const students = Array.isArray(d.students) ? d.students : [];

      for (const stu of students) {
        const studentName =
          stu.student_name ||
          stu.name ||
          stu.label ||
          '이름 미상';

        const acts = Array.isArray(stu.activities) ? stu.activities : [];

        for (const act of acts) {
          const activityName = act.activity_name || act.activity || '활동';
          const type =
            act.activity_type ||
            act.category ||
            guessActivityType(activityName);

          const minutes =
            typeof act.minutes === 'number'
              ? act.minutes
              : typeof act.activity_time === 'number'
              ? act.activity_time
              : null;

          const rawEmotions =
            act.emotions ||
            act.activity_emotion ||
            [];

          const emotions = Array.isArray(rawEmotions)
            ? rawEmotions
            : rawEmotions
            ? String(rawEmotions)
                .split(/[,\s]+/)
                .filter(Boolean)
            : [];

          records.push({
            date,
            student_name: studentName,
            activity_name: activityName,
            activity_type: type,
            minutes,
            emotions,
          });

          countByType[type] = (countByType[type] || 0) + 1;
        }
      }
    }

    // 3) 간단 요약 생성
    const total = records.length;
    let top_activity = null;
    let maxCount = 0;

    Object.entries(countByType).forEach(([t, c]) => {
      if (c > maxCount) {
        maxCount = c;
        top_activity = t;
      }
    });

    const summary = {
      total,
      top_activity,
      activity_types: Object.keys(countByType).length,
    };

    const analysis =
      total === 0
        ? '이 업로드에는 아직 활동 기록이 없습니다.'
        : `이 업로드에는 총 ${total}개의 활동 기록이 있습니다. 가장 많이 나타난 활동 유형은 「${top_activity || '활동'}」이며, 총 ${Object.keys(countByType).length}가지 유형의 활동이 발견되었습니다.`;

    return res.json({
      records,
      summary,
      analysis,
    });
  } catch (e) {
    console.error('GET /activity_types 에러:', e);
    return res.status(500).json({ message: 'Server Error', error: e.toString() });
  }
});

// DELETE /uploads/:id, /api/uploads/:id
// - 업로드 메타와 해당 파일에서 생성된 log_entries를 삭제
app.delete(['/uploads/:id', '/api/uploads/:id'], async (req, res) => {
  const { id } = req.params
  try {
    const { data: upload, error: findErr } = await supabase
      .from('ingest_uploads')
      .select('id, file_name')
      .eq('id', id)
      .single()

    if (findErr || !upload) {
      return res.status(404).json({ message: '업로드를 찾을 수 없습니다.' })
    }

    if (upload.file_name) {
      const { error: delLogsErr } = await supabase
        .from('log_entries')
        .delete()
        .eq('source_file_path', upload.file_name)
      if (delLogsErr) {
        console.error('삭제 중 log_entries 에러:', delLogsErr)
      }
    }

    const { error: delUploadErr } = await supabase
      .from('ingest_uploads')
      .delete()
      .eq('id', id)

    if (delUploadErr) {
      console.error('ingest_uploads 삭제 에러:', delUploadErr)
      return res.status(500).json({ message: 'DB Error', error: delUploadErr })
    }

    return res.status(204).send()
  } catch (e) {
    console.error('DELETE /uploads/:id 에러:', e)
    return res.status(500).json({ message: 'Server Error', error: e.toString() })
  }
})

/**
 * POST /uploads/:id/log, /api/uploads/:id/log
 * - 프론트에서 편집한 log_entries를 log_entries 테이블에 저장
 * - students 이름 기준으로 student_id 매핑 (필요시 새 학생 생성)
 */
app.post(['/uploads/:id/log', '/api/uploads/:id/log'], async (req, res) => {
  const { id } = req.params;
  const { upload_id, file_name, raw_text, log_entries } = req.body || {};

  // 1) 필수 파라미터 검사
  if (!Array.isArray(log_entries) || log_entries.length === 0) {
    return res
      .status(400)
      .json({ message: 'log_entries 배열이 필요합니다.' });
  }

  try {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // 2) 이름으로 student_id 매핑 준비 (AI 임시 ID 처리)
    const nameSet = new Set();
    for (const entry of log_entries) {
      const sid = entry.student_id;
      const sname = (entry.student_name || '').trim();
      if (!sid && sname) {
        nameSet.add(sname);
      }
    }

    let nameToId = {};

    if (nameSet.size > 0) {
      const names = [...nameSet];
      const { data: existing, error: existingErr } = await supabase
        .from('students')
        .select('id, name')
        .in('name', names);

      if (existingErr) {
        console.error('[SAVE LOG] 기존 학생 조회 에러:', existingErr);
      } else if (Array.isArray(existing)) {
        nameToId = Object.fromEntries(
          existing.map(row => [row.name, row.id]),
        );
      }

      // 없는 이름은 새 학생으로 생성
      const toInsert = names.filter(n => !nameToId[n]).map(n => ({
        name: n,
        is_active: true,
      }));

      if (toInsert.length > 0) {
        const { data: inserted, error: insertErr } = await supabase
          .from('students')
          .insert(toInsert)
          .select('id, name');

        if (insertErr) {
          console.error('[SAVE LOG] 새 학생 생성 에러:', insertErr);
        } else if (Array.isArray(inserted)) {
          for (const row of inserted) {
            nameToId[row.name] = row.id;
          }
        }
      }
    }

    // 3) log_entries 테이블에 들어갈 row 배열 생성
    const logRows = [];

    for (const entry of log_entries) {
      // student_id 결정
      let studentId = null;
      if (entry.student_id && uuidRegex.test(String(entry.student_id))) {
        studentId = entry.student_id;
      } else {
        const sname = (entry.student_name || '').trim();
        if (sname && nameToId[sname]) {
          studentId = nameToId[sname];
        }
      }

      // log_entries.student_id 는 NOT NULL 이므로 없으면 스킵
      if (!studentId) {
        console.warn(
          '[SAVE LOG] student_id 없음. 해당 entry는 log_entries에 저장하지 않음. entry=',
          entry,
        );
        continue;
      }

      // 날짜 정규화 (YYYY-MM-DD)
      const logDate = normalizeDate(entry.log_date);

      // 감정/활동/지표 정리
      const emotionTag = entry.emotion_tag || null;
      const activityTags = Array.isArray(entry.activity_tags)
        ? entry.activity_tags.filter(Boolean)
        : [];

      const rawMetrics = entry.related_metrics;
      let metricsArray = [];
      if (Array.isArray(rawMetrics)) {
        metricsArray = rawMetrics;
      } else if (rawMetrics) {
        metricsArray = [rawMetrics];
      }

      logRows.push({
        // 🔹 log_entries 테이블 스키마에 존재하는 컬럼만 전달
        log_date: logDate, // date NOT NULL
        student_id: studentId, // uuid NOT NULL
        emotion_tag: emotionTag, // text
        activity_tags: activityTags.length > 0 ? activityTags : null, // ARRAY
        log_content: entry.log_content || raw_text || '', // text
        related_metrics: metricsArray && metricsArray.length > 0 ? metricsArray : null, // ARRAY
        source_file_path: file_name || entry.source_file_path || null, // text
        status: 'success', // text, 기본값과 동일
      });
    }

    if (logRows.length === 0) {
      return res
        .status(400)
        .json({ message: '저장할 log_entries 가 없습니다.' });
    }

    // 4) 동일 source_file_path 기존 기록 삭제 (같은 파일로 다시 저장하는 경우)
    const sourceFilePath = file_name || logRows[0].source_file_path || '';
    if (sourceFilePath) {
      const { error: delErr } = await supabase
        .from('log_entries')
        .delete()
        .eq('source_file_path', sourceFilePath);

      if (delErr) {
        console.error('[SAVE LOG] 기존 log_entries 삭제 에러:', delErr);
      }
    }

    // 5) 새 log_entries insert
    const { data: inserted, error: insErr } = await supabase
      .from('log_entries')
      .insert(logRows)
      .select('id, student_id');

    if (insErr) {
      console.error('[SAVE LOG] log_entries insert 에러:', insErr);
      return res
        .status(500)
        .json({ message: 'DB Error(log_entries insert)', error: insErr });
    }

    // 6) ingest_uploads 상태 업데이트
    await supabase
      .from('ingest_uploads')
      .update({
        status: 'success',
        raw_text: raw_text || null,
      })
      .eq('id', id);

    return res.json({
      ok: true,
      count: inserted.length,
    });
  } catch (e) {
    console.error('POST /uploads/:id/log 에러:', e);
    return res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() });
  }
});

// 🧾 리포트 실행 이력 조회 API
// GET /report-runs
// (필요하면 나중에 ?status=success 같은 필터 추가 가능)
app.get(['/report-runs', '/api/report-runs'], async (req, res) => {
  try {
    let query = supabase
      .from('report_runs')
      .select(
        'id, template_id, status, error, params, created_at, updated_at',
      )
      .order('created_at', { ascending: false })
      .limit(100);

    const { data, error } = await query;

    if (error) {
      console.error('report_runs 조회 에러:', error);
      return res.status(500).json({ message: 'DB Error', error });
    }

    // 프론트에서 배열만 기대할 수도 있고, { items: [] }를 기대할 수도 있어서
    // 일단 둘 다 쓰기 좋게 items로 감싸서 내려줌.
    return res.json({
      items: data || [],
    });
  } catch (e) {
    console.error('/report-runs 에러:', e);
    return res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() });
  }
});

// 📊 대시보드용 로그 집계 API
// GET /api/dashboard?studentId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/dashboard', async (req, res) => {
  try {
    const { studentId, from, to } = req.query;

    if (!studentId) {
      return res
        .status(400)
        .json({ message: '학생 선택은 필수입니다.' });
    }

    // log_entries 테이블에서 학생 + 기간 필터로 조회
    let query = supabase
      .from('log_entries')
      .select(
        'id, log_date, student_id, emotion_tag, activity_tags, log_content, related_metrics, status',
        { count: 'exact' },
      )
      .eq('student_id', studentId)
      .order('log_date', { ascending: true });

    // status가 있으면 success만 보고 싶을 경우
    query = query.eq('status', 'success');

    if (from) {
      query = query.gte('log_date', from);
    }
    if (to) {
      query = query.lte('log_date', to);
    }

    const { data: logs, error, count } = await query;

    if (error) {
      console.error('대시보드 log_entries 조회 에러:', error);
      return res.status(500).json({ message: 'DB Error', error });
    }

    // 데이터 없을 때도 프론트에서 처리하기 쉽게 기본 구조로 응답
    if (!logs || logs.length === 0) {
      return res.json({
        metrics: { recordCount: 0 },
        emotionDistribution: [],
        activitySeries: [],
        activityAbilityList: [],
        emotionDetails: [],
        activityDetails: [],
      });
    }

    // ---------- 집계 로직 ----------

    const metrics = {
      // 총 기록 수
      recordCount: typeof count === 'number' ? count : logs.length,
    };

    const emotionCounts = {};      // { 감정: 개수 }
    const activityPerDate = {};    // { 'YYYY-MM-DD': 총 활동 수(또는 건수) }
    const emotionDetailsMap = {};  // { 감정: { emotion, totalCount, items: [] } }
    const activityDetails = [];    // 활동 상세 리스트

    for (const row of logs) {
      const dateLabel = row.log_date; // date 타입은 Supabase에서 문자열로 내려옴 (YYYY-MM-DD)
      const emo = (row.emotion_tag || '기타').trim() || '기타';

      const activities = Array.isArray(row.activity_tags)
        ? row.activity_tags.filter(Boolean)
        : [];

      // 1) 감정 분포 집계
      emotionCounts[emo] = (emotionCounts[emo] || 0) + 1;

      // 2) 날짜별 활동(또는 기록) 수 집계
      //    - 활동 태그가 있으면 그 개수를 사용, 없으면 최소 1건으로 카운트
      const perDateIncrement = activities.length > 0 ? activities.length : 1;
      activityPerDate[dateLabel] =
        (activityPerDate[dateLabel] || 0) + perDateIncrement;

      // 3) 감정 상세(emotionDetails)
      if (!emotionDetailsMap[emo]) {
        emotionDetailsMap[emo] = {
          emotion: emo,
          totalCount: 0,
          items: [],
        };
      }
      emotionDetailsMap[emo].totalCount += 1;
      emotionDetailsMap[emo].items.push({
        id: row.id,
        date: dateLabel,
        activities,
        logContent: row.log_content || '',
      });

      // 4) 활동 상세(activityDetails) – Dashboard.jsx에서 사용하는 리스트
      if (activities.length > 0) {
        for (const act of activities) {
          activityDetails.push({
            id: `${row.id}:${act}`,
            date: dateLabel,
            activity: act,
            category: act, // 지금은 활동명을 그대로 category로 사용
            emotion: emo,
            note: row.log_content || '',
          });
        }
      } else {
        // 활동 태그가 없을 때도 한 줄은 만들어줌
        activityDetails.push({
          id: row.id,
          date: dateLabel,
          activity: '기록 있음',
          category: '기타',
          emotion: emo,
          note: row.log_content || '',
        });
      }
    }

    // 1) 감정 분포 배열로 변환
    const emotionDistribution = Object.entries(emotionCounts).map(
      ([name, count]) => ({ name, count }),
    );

    // 2) 날짜별 활동 시계열 정렬 후 변환
    const activitySeries = Object.entries(activityPerDate)
      .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
      .map(([date, total]) => ({
        date,
        // 현재는 "활동 건수"를 분으로 보고 있음. 나중에 duration_minutes 같은 값을
        // related_metrics에 넣으면 실제 시간을 계산해서 넣을 수 있음.
        minutes: total,
      }));

    const emotionDetails = Object.values(emotionDetailsMap);

    // activityAbilityList는 아직 별도 지표 테이블이 없으니 빈 배열로 내려줌.
    // 나중에 능력 분석용 테이블/컬럼이 생기면 여기에서 계산해서 채우면 됨.
    return res.json({
      metrics,
      emotionDistribution,
      activitySeries,
      activityAbilityList: [],
      emotionDetails,
      activityDetails,
    });
  } catch (e) {
    console.error('/api/dashboard 에러:', e);
    return res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() });
  }
});

// --------------------------------------------------
// 대시보드용 간단 AI(요약) 대화 API
// POST /api/dashboard/chat
// body: { studentId, studentName, startDate, endDate, message, history }
// --------------------------------------------------
app.post('/api/dashboard/chat', async (req, res) => {
  try {
    const {
      studentId,
      studentName,
      startDate,
      endDate,
      message,
      // history: [{ role, content } ...]  // 지금은 사용 안 함
    } = req.body || {};

    if (!studentId || !startDate || !endDate) {
      return res.status(400).json({
        message:
          'studentId, startDate, endDate 가 모두 필요합니다. (대시보드에서 먼저 조회한 뒤 채팅을 호출해 주세요.)',
      });
    }

    // 대시보드 조회와 같은 기준으로 로그를 다시 읽어옴
    let query = supabase
      .from('log_entries')
      .select('*')
      .eq('student_id', studentId)
      .gte('log_date', startDate)
      .lte('log_date', endDate)
      .order('log_date', { ascending: true });

    const { data: logs, error } = await query;

    if (error) {
      console.error('POST /api/dashboard/chat log_entries 조회 에러:', error);
      return res.status(500).json({ message: 'DB Error', error });
    }

    if (!logs || logs.length === 0) {
      const name = studentName || '해당 학생';
      return res.json({
        answer: `${name} 학생의 ${startDate} ~ ${endDate} 기간에는 저장된 활동 기록이 없습니다.`,
      });
    }

    // 간단한 통계 (위 /api/dashboard 와 동일 로직 요약 버전)
    const daysSet = new Set();
    const emotionCounts = {};
    let totalMinutes = 0;
    let totalActivities = 0;

    function ensureArray(v) {
      if (!v) return [];
      return Array.isArray(v) ? v : [v];
    }

    for (const log of logs) {
      const date = log.log_date;
      daysSet.add(date);

      const metricsArr = Array.isArray(log.related_metrics) ? log.related_metrics : [];
      const m0 = metricsArr.length > 0 ? metricsArr[0] : null;
      const baseDuration =
        typeof m0?.duration_minutes === 'number' ? m0.duration_minutes : 0;
      const activities = Array.isArray(m0?.activities) ? m0.activities : [];

      if (activities.length > 0) {
        for (const act of activities) {
          const duration =
            typeof act.minutes === 'number'
              ? act.minutes
              : typeof act.activity_time === 'number'
              ? act.activity_time
              : baseDuration || 0;

          const rawEmotions =
            act.emotions ||
            act.activity_emotion ||
            (Array.isArray(m0?.emotionTags) ? m0.emotionTags : []) ||
            (log.emotion_tag ? [log.emotion_tag] : []);

          const emotions = ensureArray(rawEmotions).filter(Boolean);

          totalMinutes += duration;
          totalActivities += 1;

          for (const emo of emotions) {
            emotionCounts[emo] = (emotionCounts[emo] || 0) + 1;
          }
        }
      } else {
        const duration = baseDuration || 0;
        totalMinutes += duration;
        totalActivities += 1;

        const rawEmotions =
          (Array.isArray(m0?.emotionTags) ? m0.emotionTags : []) ||
          (log.emotion_tag ? [log.emotion_tag] : []);

        const emotions = ensureArray(rawEmotions).filter(Boolean);

        for (const emo of emotions) {
          emotionCounts[emo] = (emotionCounts[emo] || 0) + 1;
        }
      }
    }

    const daysCount = daysSet.size || 1;
    const averageMinutesPerDay = Math.round(totalMinutes / daysCount);

    const emotionDistribution = Object.entries(emotionCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const topEmotion = emotionDistribution[0]?.name || null;

    const name = studentName || '해당 학생';

    const baseSummary = [
      `${name} 학생의 ${startDate} ~ ${endDate} 활동 기록을 정리해 보면,`,
      `총 ${logs.length}개의 일지가 있으며,`,
      `참여한 활동은 대략 ${totalActivities}회 정도입니다.`,
      `하루 평균 활동 시간은 약 ${averageMinutesPerDay}분 수준입니다.`,
    ].join(' ');

    const emotionSummary = topEmotion
      ? `이 기간 동안 가장 자주 기록된 감정은 「${topEmotion}」입니다.`
      : '이 기간에는 감정 태그가 충분히 기록되어 있지 않습니다.';

    const userRequest = message
      ? `\n\n질문하신 내용: "${message}"\n위 통계를 참고해 학생의 강점과 어려움을 함께 살펴보세요.`
      : '';

    const answer = `${baseSummary} ${emotionSummary}${userRequest}`;

    return res.json({ answer });
  } catch (e) {
    console.error('POST /api/dashboard/chat 에러:', e);
    return res.status(500).json({ message: 'Server Error', error: e.toString() });
  }
});
