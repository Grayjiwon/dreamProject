// back/server.js
require('dotenv').config()
const express = require('express')
const { supabase } = require('./supabaseClient')
const multer = require('multer')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const {
  PDF_TXT_EXTRACTION_PROMPT,
  GET_REPORT_PROMPT,
} = require('./prompts')

const app = express()
const port = process.env.PORT || 3000

// -------------------- Gemini 클라이언트 설정 --------------------

const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
let gemini = null

if (geminiApiKey) {
  gemini = new GoogleGenerativeAI(geminiApiKey)
} else {
  console.warn(
    '⚠️ GEMINI_API_KEY 또는 GOOGLE_API_KEY 환경변수가 설정되어 있지 않습니다. Gemini 기반 기능이 비활성화됩니다.',
  )
}

// ```json 코드블록 등을 제거하면서 JSON 파싱하는 유틸
function parseJsonFromText(text) {
  if (!text) return null
  try {
    let cleaned = text.trim()
    cleaned = cleaned.replace(/^```json\s*/i, '')
    cleaned = cleaned.replace(/^```\s*/i, '')
    cleaned = cleaned.replace(/```$/i, '').trim()
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('Gemini JSON 파싱 에러:', e)
    return null
  }
}

// -------------------- 업로드 자동 AI 분석 헬퍼 --------------------

// ingest_uploads 한 건에 대해 Gemini로 records 추출만 수행하는 유틸
async function runAutoExtractionForUpload(uploadRow, rawText) {
  if (!gemini) {
    console.warn('Gemini 미설정: 자동 AI 분석을 건너뜁니다.')
    return
  }
  if (!rawText || typeof rawText !== 'string') {
    console.warn('raw_text 없음: 자동 AI 분석을 건너뜁니다.')
    return
  }

  try {
    const modelName =
      process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-flash'

    const model = gemini.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
      },
    })

    const input = {
      raw_text: rawText,
      file_name: uploadRow.file_name || null,
    }

    const prompt =
      PDF_TXT_EXTRACTION_PROMPT +
      '\n\n[입력 JSON]\n' +
      JSON.stringify(input)

    const result = await model.generateContent(prompt)
    const raw = result.response.text()
    const parsed = parseJsonFromText(raw)

    const records = parsed && Array.isArray(parsed.records)
      ? parsed.records
      : []

    console.log(
      `[AUTO AI] 업로드 ${uploadRow.id} (${uploadRow.file_name}) 분석 완료, records: ${records.length}개`,
    )

    // 필요하면 여기서 records 를 log_entries 행으로 변환해
    // /uploads/:id/log 의 로직을 참고하여 DB에 바로 저장할 수도 있음.
  } catch (e) {
    console.error(
      `[AUTO AI] 업로드 ${uploadRow.id} 자동 분석 중 오류:`,
      e,
    )
  }
}

// 업로드된 파일에서 순수 텍스트만 추출하는 유틸
async function extractPlainTextFromFile(file) {
  if (!file) return null

  // 원래 MIME 타입
  const originalMime = file.mimetype || 'application/octet-stream'

  // 1) text/* 파일은 우선 UTF-8 로 직접 디코딩
  if (originalMime.startsWith('text/')) {
    try {
      return file.buffer.toString('utf8')
    } catch (e) {
      console.error('텍스트 파일 디코딩 에러:', e)
    }
  }

  // 2) Gemini 가 설정되지 않은 경우 여기서 종료
  if (!gemini) {
    return null
  }

  // 3) Gemini에 전달할 MIME 타입 정규화
  let mimeType = originalMime

  // Hancom PDF 같은 특이 타입 → 일반 PDF 로 보정
  if (
    mimeType === 'application/haansoftpdf' ||
    mimeType === 'application/x-haansoftpdf'
  ) {
    mimeType = 'application/pdf'
  } else if (!/^application\/(pdf|json|octet-stream)$/.test(mimeType)) {
    // 그 외 이상한 application/* 타입들은 범용 바이너리로 보냄
    mimeType = 'application/octet-stream'
  }

  try {
    const base64 = file.buffer.toString('base64')
    const modelName =
      process.env.GEMINI_TEXT_MODEL ||
      process.env.GEMINI_EXTRACTION_MODEL ||
      'gemini-2.5-flash'

    const model = gemini.getGenerativeModel({ model: modelName })

    const promptText = `
당신은 업로드된 파일에서 사람이 읽을 수 있는 텍스트만 최대한 그대로 추출하는 도우미입니다.

- PDF, 이미지, 기타 문서에서 사람이 읽을 수 있는 문장만 뽑아 주세요.
- 표나 레이아웃 정보는 단순한 줄바꿈 텍스트로 표현해 주세요.
- 추가 설명, 요약, 분석 문장은 넣지 마세요.
- JSON, Markdown 코드블록, 따옴표 없이 순수한 텍스트만 그대로 출력하세요.
`

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64,
          mimeType, // ← 여기서 정규화된 mimeType 사용
        },
      },
      { text: promptText },
    ])

    let text = result.response.text() || ''
    text = text.trim()
    // 혹시 ``` 로 감싸져 온 경우 제거
    text = text.replace(/^```[a-zA-Z]*\s*/i, '').replace(/```$/i, '').trim()
    return text || null
  } catch (e) {
    console.error('Gemini 텍스트 추출 에러:', e)
    return null
  }
}

// 파일 업로드용 multer (메모리 저장)
const upload = multer({ storage: multer.memoryStorage() })

// JSON 파싱
app.use(express.json())

// CORS 허용
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  )
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With',
  )
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200)
  }
  next()
})

// -------------------- 헬스 체크 --------------------

app.get('/', (req, res) => {
  res.send('Node + Supabase 서버가 실행 중입니다.')
})

// -------------------- 로그인 (/auth/login) --------------------
/**
 * 프론트: POST {API_BASE}/auth/login 또는 {API_BASE}/api/auth/login
 */
app.post(['/auth/login', '/api/auth/login'], async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res
        .status(400)
        .json({ message: '이메일을 입력해 주세요.', code: 'NO_EMAIL' })
    }

    // Supabase Admin API 로 전체 유저를 받아서 email 로 필터
    const { data, error } = await supabase.auth.admin.listUsers()
    if (error) {
      console.error('auth.admin.listUsers 에러:', error)
      return res.status(500).json({ message: 'Auth Admin Error', error })
    }

    const user =
      data?.users?.find(
        u => (u.email || '').toLowerCase() === email.toLowerCase(),
      ) || null

    if (!user) {
      return res.status(401).json({
        message:
          '해당 이메일의 계정을 찾을 수 없습니다. Supabase Auth에서 유저를 먼저 생성해 주세요.',
        code: 'USER_NOT_FOUND',
      })
    }

    const devUser = {
      id: user.id,
      email: user.email,
      display_name:
        user.user_metadata?.full_name ||
        (user.email ? user.email.split('@')[0] : '교사'),
      role: 'observer',
    }

    return res.json({
      token: 'local-dev-token',
      user: devUser,
    })
  } catch (e) {
    console.error('POST /auth/login 에러:', e)
    return res.status(500).json({ message: 'Login Error', error: e.toString() })
  }
})

// -------------------- 업로드 API (/uploads, /api/uploads) --------------------
/**
 * POST /uploads, /api/uploads
 * - 프론트에서 FormData 로 file 하나만 보냄
 * - Supabase ingest_uploads 에 메타데이터만 기록하고,
 *   텍스트를 추출해서 ingest_uploads.raw_text 에 저장
 */
app.post(
  ['/uploads', '/api/uploads'],
  upload.single('file'),
  async (req, res) => {
    try {
      const file = req.file
      if (!file) {
        return res.status(400).json({ message: '파일이 필요합니다.' })
      }

      // multer가 latin1 인코딩으로 이름을 줄 수 있어서 UTF-8로 복원
      const originalName = Buffer.from(file.originalname, 'latin1').toString(
        'utf8',
      )

      const now = new Date().toISOString()
      const storageKey = `uploads/${Date.now()}-${originalName}`

      // 변경: FormData 에서 넘어온 uploaded_by 를 ingest_uploads 에 기록
      const uploadedBy =
        (req.body &&
          (req.body.uploaded_by ||
            req.body.user_id ||
            req.body.uploader_id)) ||
        null

      // 1) ingest_uploads 에 메타데이터 저장
const { data, error } = await supabase
        .from('ingest_uploads')
        .insert([
          {
            file_name: originalName,
            storage_key: storageKey,
            student_id: null,
            uploaded_by: uploadedBy,
            status: 'queued', // 초기 상태
            progress: 0,
            error: null,
            created_at: now,
            updated_at: now,
          },
        ])
        .select()
        .single()

      if (error) {
        console.error('ingest_uploads insert 에러:', error)
        return res.status(500).json({ message: 'DB Error', error })
      }

      // 2) 업로드된 파일에서 원본 텍스트 추출 (동기적으로 수행하여 파이프라인 보장)
      let rawText = null
      try {
        rawText = await extractPlainTextFromFile(file)
      } catch (e) {
        console.error('extractPlainTextFromFile 에러:', e)
        // 텍스트 추출 실패해도 업로드는 성공으로 처리하되 에러 로그 남김
      }

      // 3) 추출된 텍스트가 있으면 ingest_uploads.raw_text 에 저장
if (rawText) {
        try {
          const { error: upErr } = await supabase
            .from('ingest_uploads')
            .update({
              raw_text: rawText,
              // [수정] 텍스트가 나왔으므로 '처리중' 상태로 변경하여 프론트엔드와 동기화
              status: 'processing', 
              progress: 50, 
              updated_at: new Date().toISOString(),
            })
            .eq('id', data.id)

          if (upErr) {
            console.error('ingest_uploads update 에러:', upErr)
          } else {
            data.raw_text = rawText
            data.status = 'processing' // 응답 데이터도 갱신
            data.progress = 50
          }
        } catch (e) {
          console.error('ingest_uploads update 예외:', e)
        }

        // 🔹 (추가) 이 업로드 한 건에 대해 자동 AI 분석을 백그라운드로 수행
        runAutoExtractionForUpload(data, rawText).catch(err => {
          console.error(
            `[AUTO AI] 업로드 ${data.id} 자동 분석 실패:`,
            err,
          )
        })
      }
      // 4) 최종 응답 (raw_text 포함)
      return res.status(201).json(data)
    } catch (e) {
      console.error('POST /uploads 에러:', e)
      return res
        .status(500)
        .json({ message: 'Upload Error', error: e.toString() })
    }
  },
)

/**
 * GET /uploads, /api/uploads
 * - ingest_uploads + students + user_profiles 를 조합해서
 *   UploadPage.jsx 의 hydrateUpload 가 이해할 수 있는 형태로 반환
 */
app.get(['/uploads', '/api/uploads'], async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ingest_uploads')
      .select(
        'id, file_name, status, progress, error, created_at, student_id, uploaded_by',
      )
      .order('created_at', { ascending: false })

    if (error) {
      console.error('ingest_uploads 목록 조회 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    const uploadsRaw = data || []

    // student_id → 학생 이름
    const studentIds = [
      ...new Set(uploadsRaw.map(u => u.student_id).filter(Boolean)),
    ]

    let studentsById = {}
    if (studentIds.length > 0) {
      const { data: students, error: sErr } = await supabase
        .from('students')
        .select('id, name')
        .in('id', studentIds)

      if (sErr) {
        console.error('students 조회 에러:', sErr)
      } else if (students) {
        studentsById = Object.fromEntries(students.map(s => [s.id, s.name]))
      }
    }

    // uploaded_by → user_profiles.display_name
    const uploaderIds = [
      ...new Set(uploadsRaw.map(u => u.uploaded_by).filter(Boolean)),
    ]
    let uploaderById = {}
    if (uploaderIds.length > 0) {
      const { data: profiles, error: pErr } = await supabase
        .from('user_profiles')
        .select('id, display_name')
        .in('id', uploaderIds)

      if (pErr) {
        console.error('user_profiles 조회 에러:', pErr)
      } else if (profiles) {
        uploaderById = Object.fromEntries(
          profiles.map(p => [p.id, p.display_name || '']),
        )
      }
    }

    // 업로더(User) 이름은 프론트에서 카드 제목에 사용
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
    }))

    res.json(uploads)
  } catch (e) {
    console.error('GET /uploads 에러:', e)
    res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

/**
 * GET /uploads/:id, /api/uploads/:id
 * - ingest_uploads 1건 + log_entries 를 함께 내려주면서
 *   raw_text 와 학생 이름, 관련 분석 값을 싱크
 */
app.get(['/uploads/:id', '/api/uploads/:id'], async (req, res) => {
  const { id } = req.params

  try {
    // 1) 업로드 기본 정보 조회
    const { data: upload, error: uploadErr } = await supabase
      .from('ingest_uploads')
      .select('*')
      .eq('id', id)
      .single()

    if (uploadErr || !upload) {
      console.error('uploads 단일 조회 에러:', uploadErr)
      return res
        .status(404)
        .json({ message: '업로드를 찾을 수 없습니다.' })
    }

    // 2) 이 업로드와 연결된 log_entries + 학생 이름 join
    const { data: logs, error: logsErr } = await supabase
      .from('log_entries')
      .select(
        'id, log_date, student_id, emotion_tag, activity_tags, log_content, related_metrics, source_file_path, student:students(name)',
      )
      .eq('source_file_path', upload.file_name)
      .order('log_date', { ascending: true })

    if (logsErr) {
      console.error('log_entries 조회 에러 (uploads/:id):', logsErr)
    }

    const logEntriesRaw = logs || []

    // 3) raw_text 계산
    let rawText = upload.raw_text || null
    if (!rawText && logEntriesRaw.length > 0) {
      rawText = logEntriesRaw[0].log_content || null
    }

    // 4) UploadPage 상세에서 저장된 분석 값이 다시 열었을 때 보이도록
    //    related_metrics(jsonb[]) → analysis 로 매핑 + student_name 주입
    const logEntries = logEntriesRaw.map(entry => {
      const rmRaw = entry.related_metrics
      const analysis =
        Array.isArray(rmRaw) && rmRaw.length > 0
          ? rmRaw[0] || {}
          : rmRaw || entry.analysis || {}

      const studentName =
        entry.student_name ||
        (entry.student && entry.student.name) ||
        null

      return {
        ...entry,
        student_name: studentName,
        analysis,
      }
    })

    // ✅ 이 업로드에 연결된 학생 목록을 중복 없이 정리해서 같이 내려줌
    const studentMap = {}
    logEntries.forEach(e => {
      if (e.student_id && e.student_name) {
        if (!studentMap[e.student_id]) {
          studentMap[e.student_id] = {
            id: e.student_id,
            name: e.student_name,
          }
        }
      }
    })
    const students = Object.values(studentMap)

    return res.json({
      ...upload,
      raw_text: rawText, // UploadPage.openDetail 에서 사용
      log_entries: logEntries,
      students,          // ✅ 업로드에 태그된 학생 리스트
    })
  } catch (e) {
    console.error('GET /uploads/:id 에러:', e)
    return res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

/**
 * DELETE /uploads/:id, /api/uploads/:id
 * - ingest_uploads 행 삭제
 */
app.delete(['/uploads/:id', '/api/uploads/:id'], async (req, res) => {
  const { id } = req.params

  try {
    const { error } = await supabase
      .from('ingest_uploads')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('ingest_uploads 삭제 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    return res.status(204).send()
  } catch (e) {
    console.error('DELETE /uploads/:id 에러:', e)
    return res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

// -------------------- 업로드 로그 저장 (/uploads/:id/log) --------------------
/**
 * POST /uploads/:id/log, /api/uploads/:id/log
 *
 * body 예시:
 * {
 *   upload_id: "...",
 *   file_name: "파일명.pdf",
 *   raw_text: "텍스트 전문",
 *   log_entries: [
 *     {
 *       student_id: "...",          // AI에서 온 가짜 ID(a1-..., ai-...)일 수도 있음
 *       student_name: "홍길동",     // 프론트에서 같이 보내줌
 *       log_date: "2025-11-21",
 *       emotion_tag: "기쁨",
 *       activity_tags: ["미술", "글쓰기"],
 *       emotion_tags: ["즐거움", "설렘"],
 *       log_content: "...",
 *       related_metrics: {
 *         duration_minutes: 30,
 *         activity_name: "...",
 *         ...
 *       }
 *     },
 *     ...
 *   ]
 * }
 */
app.post(['/uploads/:id/log', '/api/uploads/:id/log'], async (req, res) => {
  const { id } = req.params
  const { upload_id, file_name, raw_text, log_entries } = req.body || {}

  if (!Array.isArray(log_entries) || log_entries.length === 0) {
    return res
      .status(400)
      .json({ message: 'log_entries 배열이 필요합니다.' })
  }

  try {
    // 1) UUID 형식 체크용 정규식
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    // 2) Supabase에 아직 없는 "AI 추출 학생" 후보 이름 수집
    const nameSet = new Set()

    for (const e of log_entries) {
      if (!e) continue
      const rawId = e.student_id ? String(e.student_id) : ''
      const name = (e.student_name || '').trim()

      // student_id 가 없거나 UUID 형식이 아니고, 이름이 있으면 새 학생 후보
      if ((!rawId || !uuidRegex.test(rawId)) && name) {
        nameSet.add(name)
      }
    }

    const namesNeedingId = Array.from(nameSet)
    const nameToStudentId = {}

    // 3) 이미 존재하는 학생들 먼저 조회
    if (namesNeedingId.length > 0) {
      const { data: existingStudents, error: existingErr } = await supabase
        .from('students')
        .select('id, name')
        .in('name', namesNeedingId)

      if (existingErr) {
        console.error('AI 추출 학생 기존 조회 에러:', existingErr)
      } else if (existingStudents) {
        for (const stu of existingStudents) {
          if (stu && stu.name && stu.id) {
            nameToStudentId[stu.name] = stu.id
          }
        }
      }

      // 4) 아직 없는 이름들만 새로 students 에 insert
      const namesToCreate = namesNeedingId.filter(
        name => !nameToStudentId[name],
      )

      if (namesToCreate.length > 0) {
        const payload = namesToCreate.map(name => ({
          // students 테이블에서 name만 NOT NULL, 나머지는 null/default 허용:contentReference[oaicite:0]{index=0}
          name,
        }))

        const { data: insertedStudents, error: createErr } = await supabase
          .from('students')
          .insert(payload)
          .select('id, name')

        if (createErr) {
          console.error('AI 추출 학생 자동 생성 에러:', createErr)
        } else if (insertedStudents) {
          for (const stu of insertedStudents) {
            if (stu && stu.name && stu.id) {
              nameToStudentId[stu.name] = stu.id
            }
          }
        }
      }
    }

    // 5) log_entries → 실제 DB에 넣을 rows 변환
    const rows = log_entries
      .map(e => {
        if (!e) return null

        let studentId = e.student_id ? String(e.student_id) : ''
        const name = (e.student_name || '').trim()

        // activity_tags 는 배열로 정규화
        let activityTags = Array.isArray(e.activity_tags)
          ? [...e.activity_tags]
          : e.activity_tags
          ? [e.activity_tags]
          : []

        // UUID가 아닌 ID(ai-..., local-...) 또는 비어 있는 경우:
        //  - student_name 기준으로 students 테이블에서 id 찾기/자동 생성한 id 사용
        //  - 태그에 "학생:이름" 형태로도 한 줄 남김
        if (!studentId || !uuidRegex.test(studentId)) {
          if (name && nameToStudentId[name]) {
            studentId = nameToStudentId[name]
            const tagLabel = `학생:${name}`
            if (!activityTags.includes(tagLabel)) {
              activityTags.push(tagLabel)
            }
          } else {
            // 이름조차 없으면 이 기록은 저장 불가 → 스킵
            return null
          }
        }

        // 🔸 related_metrics 를 DB 타입(jsonb[])에 맞게 항상 "배열"로 맞춰준다.
        let metrics = e.related_metrics
        if (metrics == null) {
          metrics = null
        } else if (Array.isArray(metrics)) {
          metrics = metrics
        } else {
          metrics = [metrics]
        }

        // ✅ 감정: 단일 필드(emotion_tag)에 대표 감정을 넣어준다.
        //  - e.emotion_tag 가 있으면 그대로
        //  - 없으면 emotion_tags 배열의 첫 번째 값을 사용
        let primaryEmotion = e.emotion_tag || null
        if (!primaryEmotion && Array.isArray(e.emotion_tags) && e.emotion_tags.length > 0) {
          primaryEmotion = e.emotion_tags[0]
        }

        // (선택) emotion_tags 전체를 metrics 안에 같이 남기고 싶다면
        if (Array.isArray(e.emotion_tags) && e.emotion_tags.length > 0) {
          if (!metrics) {
            metrics = [{ emotion_tags: e.emotion_tags }]
          } else if (Array.isArray(metrics) && metrics.length > 0) {
            metrics[0] = { ...metrics[0], emotion_tags: e.emotion_tags }
          }
        }

        return {
          log_date: e.log_date || new Date().toISOString().slice(0, 10),
          student_id: studentId, // log_entries.student_id (uuid NOT NULL)
          emotion_tag: primaryEmotion || null,           // ✅ 대시보드 집계용
          activity_tags: activityTags.length > 0 ? activityTags : null, // text[]
          log_content: e.log_content || null,
          related_metrics: metrics, // jsonb[]
          source_file_path: file_name || null,
        }
      })
      .filter(Boolean)

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ message: '학생 정보가 있는 기록이 없습니다.' })
    }

    // 6) source_file_path 기준으로 기존 로그를 삭제하고 새로 저장 (overwrite)
    if (file_name) {
      await supabase
        .from('log_entries')
        .delete()
        .eq('source_file_path', file_name)
    }

    // 7) log_entries insert
    const { data: inserted, error: insertErr } = await supabase
      .from('log_entries')
      .insert(rows)
      .select()

    if (insertErr) {
      console.error('log_entries insert 에러:', insertErr)
      return res.status(500).json({
        message: 'log_entries 저장 중 오류',
        error: insertErr,
      })
    }

    // 8) ingest_uploads 의 student_id / status 업데이트
    const firstStudentId = rows[0].student_id

const { error: upErr } = await supabase
      .from('ingest_uploads')
      .update({
        student_id: firstStudentId,
        status: 'success', // [중요] DB 상태를 완료로 변경
        progress: 100,     // [중요] 진행률 100%
        updated_at: new Date().toISOString()
      })
      .eq('id', id)

    if (upErr) {
      console.error('ingest_uploads 업데이트 에러:', upErr)
    }

    return res.status(201).json({
      upload_id: id,
      file_name,
      raw_text,
      log_entries: inserted,
    })
  } catch (e) {
    console.error('POST /uploads/:id/log 에러:', e)
    return res.status(500).json({
      message: 'Upload log save error',
      error: e.toString(),
    })
  }
})

// -------------------- log_entries 조회 (UploadPage 상세용) --------------------
/**
 * GET /log_entries?upload_id=...
 * - upload_id 로 ingest_uploads 를 찾고, 해당 student_id 의 로그를 최근 순으로 반환
 */
app.get('/log_entries', async (req, res) => {
  const { upload_id } = req.query

  try {
    let studentId = null

    if (upload_id) {
      const { data: upload, error: uErr } = await supabase
        .from('ingest_uploads')
        .select('student_id')
        .eq('id', upload_id)
        .single()

      if (uErr) {
        console.error('ingest_uploads 조회 에러:', uErr)
      } else {
        studentId = upload?.student_id || null
      }
    }

    let query = supabase
      .from('log_entries')
      .select('*')
      .order('log_date', { ascending: false })
      .limit(20)

    if (studentId) {
      query = query.eq('student_id', studentId)
    }

    const { data, error } = await query

    if (error) {
      console.error('log_entries 조회 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    res.json(data || [])
  } catch (e) {
    console.error('GET /log_entries 에러:', e)
    res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

// -------------------- Supabase 스타일 REST 프록시 --------------------

/**
 * POST /rest/v1/log_entries
 * - body 전체를 log_entries 에 insert(1건)
 */
app.post('/rest/v1/log_entries', async (req, res) => {
  try {
    const body = req.body || {}

    const { data, error } = await supabase
      .from('log_entries')
      .insert([body])
      .select()
      .single()

    if (error) {
      console.error('log_entries insert 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    res.status(201).json(data)
  } catch (e) {
    console.error('POST /rest/v1/log_entries 에러:', e)
    res
      .status(500)
      .json({ message: 'DB Error', error: e.toString() })
  }
})

/**
 * POST /rest/v1/log_entry_tags
 * - body: [{ log_entry_id, tag_id }, ...]
 */
app.post('/rest/v1/log_entry_tags', async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : []
    if (rows.length === 0) {
      return res.status(400).json({ message: '배열 형태의 body가 필요합니다.' })
    }

    const { data, error } = await supabase
      .from('log_entry_tags')
      .insert(rows)
      .select()

    if (error) {
      console.error('log_entry_tags insert 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    res.status(201).json(data)
  } catch (e) {
    console.error('POST /rest/v1/log_entry_tags 에러:', e)
    res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

/**
 * GET /rest/v1/tags?select=*
 * - 감정 키워드 전체 조회용 간단 프록시
 */
app.get('/rest/v1/tags', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tags')
      .select('id, name')
      .order('created_at', { ascending: true })

    if (error) {
      console.error('tags 조회 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    const rows = (data || []).map(t => ({
      id: t.id,
      name: t.name,
      label: t.name,
    }))

    res.json(rows)
  } catch (e) {
    console.error('GET /rest/v1/tags 에러:', e)
    res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

/**
 * POST /rest/v1/tags
 * - 새로운 감정 키워드 추가
 */
app.post('/rest/v1/tags', async (req, res) => {
  try {
    const { name } = req.body || {}
    if (!name) {
      return res.status(400).json({ message: 'name 필드가 필요합니다.' })
    }

    const { data, error } = await supabase
      .from('tags')
      .insert([{ name }])
      .select()
      .single()

    if (error) {
      console.error('tags insert 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    res.status(201).json(data)
  } catch (e) {
    console.error('POST /rest/v1/tags 에러:', e)
    res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

// -------------------- /api/students, /api/log_entries --------------------
// (Dashboard, StudentList 페이지에서 사용)

app.get('/api/students', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query

  let query = supabase
    .from('students')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error, count } = await query

  if (error) {
    console.error('students 목록 조회 에러:', error)
    return res.status(500).json({ message: 'DB Error', error })
  }

  res.json({
    count,
    items: data,
  })
})

app.get('/api/students/:id', async (req, res) => {
  const { id } = req.params

  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !data) {
    console.error('students 상세 조회 에러:', error)
    return res.status(404).json({ message: '학생을 찾을 수 없습니다.', error })
  }

  res.json(data)
})

// StudentDetail 에서 사용하는 더미용(또는 확장용) 엔드포인트
app.get('/students/:id/activities', async (req, res) => {
  const { id } = req.params
  try {
    const { data, error } = await supabase
      .from('log_entries')
      .select('*')
      .eq('student_id', id)
      .order('log_date', { ascending: false })
      .limit(50)

    if (error) {
      console.error('students/:id/activities 조회 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    res.json(data || [])
  } catch (e) {
    console.error('GET /students/:id/activities 에러:', e)
    res
      .status(500)
      .json({ message: 'Server Error', error: e.toString() })
  }
})

// 학생 추가
app.post('/api/students', async (req, res) => {
  try {
    const {
      name,
      status,
      current_status,
      admission_date,
      birth_date,
      notes,
      memo,
      school_level,
      alias,
      is_active,
    } = req.body || {}

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'name은 필수입니다.' })
    }

    // 상태 값 정리: current_status > status > '재학중'
    const statusValue = current_status || status || '재학중'
    // 메모 값 정리: memo > notes
    const memoValue = memo !== undefined ? memo : notes

    const payload = {
      name: name.trim(),
      status: statusValue,          // 기존 컬럼
      current_status: statusValue,  // 새 컬럼
      admission_date: admission_date || null,
      birth_date: birth_date || null,
      school_level: school_level || null,
      alias: alias || null,
      is_active:
        typeof is_active === 'boolean' ? is_active : true,
    }

    if (memoValue !== undefined) {
      payload.memo = memoValue
      payload.notes = memoValue // 기존 notes 컬럼도 같이 유지
    }

    console.log('POST /api/students payload:', payload)

    const { data, error } = await supabase
      .from('students')
      .insert([payload])
      .select()
      .single()

    if (error) {
      console.error('students 추가 에러:', error)
      return res
        .status(500)
        .json({ message: '학생 추가 중 오류가 발생했습니다.' })
    }

    const normalized = {
      ...data,
      current_status: data.current_status || data.status || null,
      memo: data.memo || data.notes || null,
    }

    return res.json(normalized)
  } catch (err) {
    console.error('POST /api/students 서버 오류:', err)
    res.status(500).json({ message: '서버 오류' })
  }
})

app.patch('/api/students/:id', async (req, res) => {
  const { id } = req.params

  try {
    const {
      name,
      status,
      current_status,
      admission_date,
      birth_date,
      notes,
      memo,           // 프론트에서 memo로 보내도 처리
      school_level,
      alias,
      is_active,
    } = req.body || {}

    const updateData = {}

    if (name !== undefined) updateData.name = name

    // 상태 값: current_status > status
    const statusValue =
      current_status !== undefined ? current_status : status
    if (statusValue !== undefined) {
      updateData.current_status = statusValue
      updateData.status = statusValue // 기존 컬럼도 같이 변경
    }

    if (admission_date !== undefined) {
      updateData.admission_date = admission_date
    }

    if (birth_date !== undefined) {
      updateData.birth_date = birth_date
    }

    // 메모 값: memo > notes
    const memoValue = memo !== undefined ? memo : notes
    if (memoValue !== undefined) {
      updateData.memo = memoValue
      updateData.notes = memoValue // 기존 notes 컬럼도 같이 유지
    }

    if (school_level !== undefined) {
      updateData.school_level = school_level
    }

    if (alias !== undefined) {
      updateData.alias = alias
    }

    if (is_active !== undefined) {
      updateData.is_active = is_active
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: '업데이트할 필드가 없습니다.' })
    }

    const { data, error } = await supabase
      .from('students')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('students 수정 에러:', error)
      return res.status(500).json({
        message: 'DB Error',
        detail: error.message || error.toString(),
      })
    }

    const normalized = {
      ...data,
      current_status: data.current_status || data.status || null,
      memo: data.memo || data.notes || null,
    }

    return res.json(normalized)
  } catch (e) {
    console.error('PATCH /api/students/:id 예외:', e)
    return res
      .status(500)
      .json({ message: 'Server Error', detail: e.toString() })
  }
})

app.delete('/api/students/:id', async (req, res) => {
  const { id } = req.params

  const { error } = await supabase.from('students').delete().eq('id', id)

  if (error) {
    console.error('students 삭제 에러:', error)
    return res.status(500).json({ message: 'DB Error', error })
  }

  res.status(204).send()
})

// log_entries 목록/상세/추가/수정/삭제
app.get('/api/log_entries', async (req, res) => {
  const {
    student_id,
    from, // 시작 날짜
    to, // 종료 날짜
    status,
    limit = 50,
    offset = 0,
  } = req.query

  let query = supabase
    .from('log_entries')
    .select('*', { count: 'exact' })
    .order('log_date', { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  // ✅ "전체" / "ALL" 등은 필터를 적용하지 않음
  const isAllStudent =
    student_id === 'ALL' ||
    student_id === 'all' ||
    student_id === '전체'

  if (student_id && !isAllStudent) {
    query = query.eq('student_id', student_id)
  }
  if (from) {
    query = query.gte('log_date', from)
  }
  if (to) {
    query = query.lte('log_date', to)
  }
  if (status) {
    query = query.eq('status', status)
  }

  const { data, error, count } = await query

  if (error) {
    console.error('log_entries 목록 조회 에러:', error)
    return res.status(500).json({ message: 'DB Error', error })
  }

  res.json({
    count,
    items: data,
  })
})

app.get('/api/log_entries/:id', async (req, res) => {
  const { id } = req.params

  const { data, error } = await supabase
    .from('log_entries')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !data) {
    console.error('log_entries 상세 조회 에러:', error)
    return res.status(404).json({ message: '기록을 찾을 수 없습니다.', error })
  }

  res.json(data)
})

app.patch('/api/log_entries/:id', async (req, res) => {
  const { id } = req.params
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
  } = req.body

  const updateData = {}
  if (log_date !== undefined) updateData.log_date = log_date
  if (student_id !== undefined) updateData.student_id = student_id
  if (observer_id !== undefined) updateData.observer_id = observer_id
  if (emotion_tag !== undefined) updateData.emotion_tag = emotion_tag
  if (activity_tags !== undefined) updateData.activity_tags = activity_tags
  if (log_content !== undefined) updateData.log_content = log_content
  if (related_metrics !== undefined) updateData.related_metrics = related_metrics
  if (status !== undefined) updateData.status = status
  if (source_file_path !== undefined) updateData.source_file_path = source_file_path

  const { data, error } = await supabase
    .from('log_entries')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('log_entries 수정 에러:', error)
    return res.status(500).json({ message: 'DB Error', error })
  }

  res.json(data)
})

app.delete('/api/log_entries/:id', async (req, res) => {
  const { id } = req.params

  const { error } = await supabase.from('log_entries').delete().eq('id', id)

  if (error) {
    console.error('log_entries 삭제 에러:', error)
    return res.status(500).json({ message: 'DB Error', error })
  }

  res.status(204).send()
})

// -------------------- Gemini AI 연동 API --------------------

/**
 * POST /ai/extract-records 또는 /api/ai/extract-records
 */
app.post(
  ['/ai/extract-records', '/api/ai/extract-records'],
  async (req, res) => {
    if (!gemini) {
      return res.status(500).json({
        ok: false,
        code: 'NO_GEMINI_KEY',
        message:
          'Gemini API key(GEMINI_API_KEY/GOOGLE_API_KEY)가 설정되어 있지 않습니다.',
      })
    }

    const { raw_text, file_name } = req.body || {}

    if (!raw_text || typeof raw_text !== 'string') {
      return res
        .status(400)
        .json({ ok: false, message: 'raw_text 문자열이 필요합니다.' })
    }

    try {
      const input = {
        raw_text,
        file_name: file_name || null,
      }

      const modelName =
        process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-flash'

      const model = gemini.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      })

      const prompt =
        PDF_TXT_EXTRACTION_PROMPT +
        '\n\n[입력 JSON]\n' +
        JSON.stringify(input)

      const result = await model.generateContent(prompt)
      const raw = result.response.text()
      const parsed = parseJsonFromText(raw)

      return res.json({
        ok: true,
        model: modelName,
        raw,
        parsed,
      })
    } catch (e) {
      console.error('POST /ai/extract-records 에러:', e)
      return res.status(500).json({
        ok: false,
        message: 'Gemini 추출 중 오류가 발생했습니다.',
        error: e.toString(),
      })
    }
  },
)

/**
 * POST /ai/generate-report 또는 /api/ai/generate-report
 */
app.post(
  ['/ai/generate-report', '/api/ai/generate-report'],
  async (req, res) => {
    if (!gemini) {
      return res.status(500).json({
        ok: false,
        code: 'NO_GEMINI_KEY',
        message:
          'Gemini API key(GEMINI_API_KEY/GOOGLE_API_KEY)가 설정되어 있지 않습니다.',
      })
    }

    try {
      const {
        student_profile,
        date_range,
        summary_stats,
        activity_samples,
        report_options,
      } = req.body || {}

      const payload = {
        student_profile: student_profile || null,
        date_range: date_range || null,
        summary_stats: summary_stats || null,
        activity_samples: Array.isArray(activity_samples)
          ? activity_samples
          : [],
        report_options: report_options || {},
      }

      const categoryCode =
        (report_options && report_options.category_code) || 'full'
      const categoryLabel =
        (report_options && report_options.category_label) || '전체 리포트'

      const purposeCode = report_options && report_options.purpose
      const purposeForPrompt =
        purposeCode === 'parent'
          ? '학부모 상담용'
          : purposeCode === 'school'
          ? '학교 제출용'
          : '기본 리포트'

      const toneForPrompt =
        (report_options && report_options.tone) ||
        '분석적이고 요약 중심의 톤'

      const basePrompt = GET_REPORT_PROMPT(
        categoryCode || categoryLabel,
        purposeForPrompt,
        toneForPrompt,
      )

      const finalPrompt = basePrompt.replace(
        '{input_json}',
        JSON.stringify(payload, null, 2),
      )

      const modelName = process.env.GEMINI_REPORT_MODEL || 'gemini-2.5-flash'

      const model = gemini.getGenerativeModel({
        model: modelName,
      })

      const result = await model.generateContent(finalPrompt)
      const markdown = result.response.text()

      return res.json({
        ok: true,
        model: modelName,
        markdown,
      })
    } catch (e) {
      console.error('POST /ai/generate-report 에러:', e)
      return res.status(500).json({
        ok: false,
        message: 'Gemini 리포트 생성 중 오류가 발생했습니다.',
        error: e.toString(),
      })
    }
  },
)

// -------------------- 대시보드 집계 API (/api/dashboard) --------------------
app.get('/api/dashboard', async (req, res) => {
  const { studentId, from, to, startDate, endDate } = req.query
  const fromDate = from || startDate || null
  const toDate = to || endDate || null

  try {
    let query = supabase
      .from('log_entries')
      .select(
        'id, log_date, emotion_tag, related_metrics, activity_tags, log_content, created_at',
      )

    const rawStudentId = studentId || null
    const isAllStudent =
      rawStudentId === 'ALL' ||
      rawStudentId === 'all' ||
      rawStudentId === '전체'

    if (rawStudentId && !isAllStudent) {
      query = query.eq('student_id', rawStudentId)
    }
    if (fromDate) {
      query = query.gte('log_date', fromDate)
    }
    if (toDate) {
      query = query.lte('log_date', toDate)
    }

    const { data, error } = await query

    if (error) {
      console.error('GET /api/dashboard DB 에러:', error)
      return res.status(500).json({ message: 'DB Error', error })
    }

    const logs = data || []
    const recordCount = logs.length

    const emotionCounts = {}
    const emotionDetailMap = {}
    const byDate = {}
    
    // [수정] 변수 선언 누락 수정 및 초기화
    const activityDetails = [] 
    const activityAbilityList = [] 

    logs.forEach(l => {
      const date =
        l.log_date ||
        (l.created_at ? String(l.created_at).slice(0, 10) : null)

      const emotionName = (l.emotion_tag || '감정 미기록').toString()

      // related_metrics 처리
      const rmRaw = l.related_metrics
      const rm =
        Array.isArray(rmRaw) && rmRaw.length > 0
          ? rmRaw[0] || {}
          : rmRaw || {}

      const activityName =
        rm.activity_name ||
        rm.activity ||
        (Array.isArray(l.activity_tags) && l.activity_tags.length
          ? l.activity_tags[0]
          : '')
      const category =
        rm.category || rm.activity_category || rm.main_type || null
      const activityType =
        rm.activity_type || rm.activityType || rm.group_type || null

      // 감정 카운트
      if (!emotionCounts[emotionName]) emotionCounts[emotionName] = 0
      emotionCounts[emotionName]++

      if (!emotionDetailMap[emotionName]) {
        emotionDetailMap[emotionName] = {
          emotion: emotionName,
          totalCount: 0,
          dates: {},
        }
      }
      const detail = emotionDetailMap[emotionName]
      detail.totalCount++
      if (date) {
        if (!detail.dates[date]) {
          detail.dates[date] = { count: 0, activities: new Set() }
        }
        detail.dates[date].count++
        if (activityName) detail.dates[date].activities.add(activityName)
      }

      // 시간 계산
      const minutes =
        typeof rm.minutes === 'number'
          ? rm.minutes
          : typeof rm.duration_minutes === 'number'
          ? rm.duration_minutes
          : 0 // 기본값 0

      if (date) {
        byDate[date] = (byDate[date] || 0) + minutes
      }

      // 활동 능력 리스트 구성
      const level = rm.level || '보통'
      let levelType = 'good'
      if (level.includes('우수') || level.includes('탁월')) levelType = 'excellent'
      else if (level.includes('도전') || level.includes('노력')) levelType = 'challenge'
      
      const score = typeof rm.score === 'number' ? rm.score : 0

      // [수정] activityAbilityList에 안전하게 push
      activityAbilityList.push({
        id: l.id,
        activity: activityName || '활동',
        date: date || '',
        levelType,
        levelLabel: level,
        difficultyRatio: 0, 
        normalRatio: 0,
        goodRatio: 0,
        totalScore: score,
        hours: minutes ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : '0시간 0분',
        mainSkills: Array.isArray(rm.ability) ? rm.ability : [],
      })

      activityDetails.push({
        date,
        activity: activityName || '',
        category,
        activityType,
        comment: l.log_content || '',
        emotion: l.emotion_tag || null,
      })
    })

    const emotionDistribution = Object.entries(emotionCounts)
      .map(([name, count]) => ({
        name,
        count,
        value:
          recordCount > 0
            ? Math.round((count / recordCount) * 100)
            : 0,
      }))
      .sort((a, b) => b.count - a.count)

    const emotionDetails = Object.values(emotionDetailMap)
      .map(detail => ({
        emotion: detail.emotion,
        totalCount: detail.totalCount,
        items: Object.entries(detail.dates)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, info]) => ({
            date,
            count: info.count,
            activities: Array.from(info.activities),
          })),
      }))
      .sort((a, b) => b.totalCount - a.totalCount)

    const activitySeries = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, minutes]) => ({ date, minutes }))

    const metrics = {
      recordCount,
    }

    return res.json({
      metrics,
      emotionDistribution,
      emotionDetails,
      activitySeries,
      activityAbilityList,
      activityDetails,
    })
  } catch (e) {
    console.error('GET /api/dashboard 에러:', e)
    return res
      .status(500)
      .json({ message: 'Dashboard Error', error: e.toString() })
  }
})

// -------------------- 대시보드 Gemini 채팅 API (/api/dashboard/chat) --------------------
app.post('/api/dashboard/chat', async (req, res) => {
  const {
    studentId,
    studentName,
    startDate,
    endDate,
    message,
    history = [],
  } = req.body || {}

  if (!message || typeof message !== 'string') {
    return res
      .status(400)
      .json({ message: 'message 필드는 필수입니다.' })
  }

  try {
    let logs = []

    // ✅ "전체" / "ALL" 값은 특정 학생 필터 없이 조회
    const isAllStudent =
      studentId === 'ALL' ||
      studentId === 'all' ||
      studentId === '전체'

    const normalizedStudentId = isAllStudent ? null : studentId

    if (normalizedStudentId && startDate && endDate && typeof supabase !== 'undefined') {
      let query = supabase
        .from('log_entries')
        .select(
          'log_date, emotion_tag, related_metrics, activity_tags, log_content, created_at',
        )
        .eq('student_id', normalizedStudentId)
        .gte('log_date', startDate)
        .lte('log_date', endDate)

      const { data, error } = await query

      if (error) {
        console.error('POST /api/dashboard/chat DB 에러:', error)
      } else {
        logs = data || []
      }
    }

    const recordCount = logs.length
    const emotionSamples = []

    logs.forEach((l, idx) => {
      const tag = (l.emotion_tag || '').toString()

      // 🔸 배열/객체 모두 지원
      const rmRaw = l.related_metrics
      const rm =
        Array.isArray(rmRaw) && rmRaw.length > 0
          ? rmRaw[0] || {}
          : rmRaw || {}

      if (idx < 10) {
        emotionSamples.push({
          date:
            l.log_date ||
            (l.created_at ? String(l.created_at).slice(0, 10) : null),
          emotion_tag: tag,
          activity_tags: l.activity_tags || null,
          score: rm.score ?? rm.level_score ?? null,
          log_content: l.log_content || null,
        })
      }
    })

    const historyText = (history || [])
      .map(h => `${h.role === 'user' ? '교사' : 'AI'}: ${h.content}`)
      .join('\n')

    const statsForPrompt = {
      studentId,
      studentName,
      period: { startDate, endDate },
      recordCount,
      emotionSamples,
    }

    const systemPrompt = `
당신은 텃밭/농장 활동 기록을 분석해서 학생의 감정, 활동, 성장 패턴을 교사가 이해하기 쉽게 설명해 주는 한국어 AI 도우미입니다.

- 데이터에 근거해서 차분하고 구체적으로 설명하세요.
- 학부모 상담이나 기록 작성에 바로 쓸 수 있도록 요약과 해석을 제공합니다.
- 너무 장황하지 않게 3~6문단 이내로 정리하고, 필요하면 글머리 기호를 사용해 주세요.
`

    const userPrompt = `
[학생 및 기간 정보]
- 학생 이름: ${studentName || '이름 미상'}
- 학생 ID: ${studentId || 'N/A'}
- 기간: ${startDate || '-'} ~ ${endDate || '-'}

[요약 데이터(JSON)]
${JSON.stringify(statsForPrompt, null, 2)}

[이전 대화]
${historyText || '(이전 대화 없음)'}

[교사의 질문]
"""${message}"""

위 정보를 바탕으로, 교사가 이해하기 쉬운 한국어로 답변해 주세요.
데이터가 부족한 부분이 있다면 "이 부분은 데이터가 부족합니다"라고 솔직하게 말해 주세요.
`

    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY가 설정되어 있지 않습니다.')
      return res.json({
        answer:
          '현재 서버에 Gemini API 키(GEMINI_API_KEY)가 설정되어 있지 않아 실제 AI 응답을 생성할 수 없습니다. 백엔드 .env 또는 Render 환경 변수에서 GEMINI_API_KEY를 설정한 뒤 다시 시도해 주세요.',
      })
    }

    const geminiUrl =
      '[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent)' +
      `?key=${process.env.GEMINI_API_KEY}`

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: systemPrompt + '\n\n' + userPrompt }],
        },
      ],
    }

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const text = await geminiResponse.text()

    if (!geminiResponse.ok) {
      console.error(
        'Gemini API error:',
        geminiResponse.status,
        text,
      )

      return res.status(500).json({
        message: 'Gemini API Error',
        detail: text,
      })
    }

    let geminiJson = {}
    try {
      geminiJson = JSON.parse(text)
    } catch {
      geminiJson = {}
    }

    const answer =
      geminiJson?.candidates?.[0]?.content?.parts
        ?.map(p => p.text || '')
        .join('') ||
      'AI 응답을 불러오지 못했습니다. 프롬프트나 서버 설정을 확인해 주세요.'

    return res.json({ answer })
  } catch (e) {
    console.error('POST /api/dashboard/chat 에러:', e)
    return res
      .status(500)
      .json({ message: 'Chat Error', error: e.toString() })
  }
})

/**
 * POST /report-runs, /api/report-runs
 * - AI 리포트 요청 (Report.jsx 에서 호출)
 */
app.post(['/report-runs', '/api/report-runs'], async (req, res) => {
  try {
    // -------------------------------
    // 1) body 구조 파싱 (중첩 body 방어)
    // -------------------------------
    const raw = req.body || {}

    // 만약 { body: { ... } } 형태로 들어오면 안쪽 body 객체를 payload 로 사용
    const root =
      raw &&
      typeof raw === 'object' &&
      raw.body &&
      typeof raw.body === 'object' &&
      !Array.isArray(raw.body)
        ? raw.body
        : raw

    // 여기부터는 순수 root 가 "실제 요청 JSON" 이라고 가정
    const { template_code, template_id, requested_by } = root

    // 1차로 params 를 꺼낸다
    let incomingParams = root.params

    // 혹시 만약 params 가 문자열(JSON 문자열)로 넘어오면 파싱
    if (typeof incomingParams === 'string') {
      try {
        incomingParams = JSON.parse(incomingParams)
      } catch (e) {
        console.warn('POST /report-runs: params JSON 파싱 실패, 원본 문자열 그대로 사용합니다.', e)
      }
    }

    // -------------------------------
    // 2) params 만들기
    // -------------------------------
    let finalParams = null

    // (1) 정상적으로 params 객체가 온 경우 그대로 사용
    if (
      incomingParams &&
      typeof incomingParams === 'object' &&
      !Array.isArray(incomingParams)
    ) {
      finalParams = { ...incomingParams }
    } else {
      // (2) params 가 없거나 문자열/배열 등 비정상 형태면
      //     template_code / template_id / requested_by / params 를 제외한
      //     나머지 필드를 모두 params 로 넣어 준다
      const fallback = {}

      Object.keys(root).forEach(key => {
        if (
          key === 'template_code' ||
          key === 'template_id' ||
          key === 'requested_by' ||
          key === 'params'
        ) {
          return
        }
        fallback[key] = root[key]
      })

      finalParams = Object.keys(fallback).length > 0 ? fallback : {}
    }

    // 혹시 최상단에 markdown 필드로 들어온 경우에도 params 에 보장
    if (!finalParams.markdown && typeof root.markdown === 'string') {
      finalParams.markdown = root.markdown
    }

    // params 가 결국이라도 falsy 하면 비어있는 객체라도 넣어준다
    if (!finalParams) finalParams = {}

    // -------------------------------
    // 3) 사용할 템플릿 결정 (template_id / template_code)
    // -------------------------------
    const codeToUse = template_code || 'default_md'
    let tplId = template_id || null

    // template_id 가 없으면 code 기반으로 템플릿 조회
    if (!tplId) {
      const { data: tpl, error: tplErr } = await supabase
        .from('report_templates')
        .select('id, code, name, format, config')
        .eq('code', codeToUse)
        .single()

      if (!tplErr && tpl) {
        tplId = tpl.id
      }
    }

    // 그래도 템플릿이 없으면 기본 템플릿 생성 (md 포맷)
    if (!tplId) {
      const { data: createdTpl, error: createErr } = await supabase
        .from('report_templates')
        .insert([
          {
            code: codeToUse,
            name:
              codeToUse === 'ai_markdown'
                ? 'AI 마크다운 리포트'
                : '기본 리포트 템플릿',
            format: 'md',
            config: null,
          },
        ])
        .select('id')
        .single()

      if (createErr || !createdTpl) {
        console.error('report_templates insert 에러:', createErr)
        return res
          .status(500)
          .json({
            message: '리포트 템플릿 생성 중 오류가 발생했습니다.',
            error: createErr,
          })
      }
      tplId = createdTpl.id
    }

    // -------------------------------
    // 4) report_runs 에 실제로 저장될 payload
    // -------------------------------
    const payload = {
      template_id: tplId, // NOT NULL
      params: finalParams, // jsonb NOT NULL
      requested_by: requested_by || null,
      status: 'completed', // 새 AI 리포트는 바로 completed 상태로
    }

    const { data, error } = await supabase
      .from('report_runs')
      .insert([payload])
      .select(
        `
        id,
        template_id,
        requested_by,
        params,
        status,
        error,
        created_at,
        updated_at,
        template:report_templates (
          id,
          code,
          name,
          format,
          config
        )
      `,
      )
      .single()

    if (error) {
      console.error('report_runs insert 에러:', error)
      return res
        .status(500)
        .json({ message: 'DB Error', detail: error.message || String(error) })
    }

    return res.status(201).json(data)
  } catch (e) {
    console.error('POST /report-runs 예외:', e)
    return res
      .status(500)
      .json({ message: 'Server Error', detail: e.toString() })
  }
})

/**
 * GET /report-runs, /api/report-runs
 * - 리포트 실행 목록 조회
 */
app.get(['/report-runs', '/api/report-runs'], async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('report_runs')
      .select(
        `
        id,
        template_id,
        requested_by,
        params,
        status,
        error,
        created_at,
        updated_at,
        template:report_templates (
          id,
          code,
          name,
          format,
          config
        )
      `,
      )

    if (error) {
      console.error('report_runs 목록 조회 에러:', error)
      return res
        .status(500)
        .json({ message: 'DB Error', detail: error.message || String(error) })
    }

    return res.json(data || [])
  } catch (e) {
    console.error('GET /report-runs 예외:', e)
    return res
      .status(500)
      .json({ message: 'Server Error', detail: e.toString() })
  }
})

/**
 * GET /report-runs/:id, /api/report-runs/:id
 */
app.get(['/report-runs/:id', '/api/report-runs/:id'], async (req, res) => {
  const { id } = req.params

  try {
    const { data, error } = await supabase
      .from('report_runs')
      .select(
        `
        id,
        template_id,
        requested_by,
        params,
        status,
        error,
        created_at,
        updated_at,
        template:report_templates (
          id,
          code,
          name,
          format,
          config
        )
      `,
      )
      .eq('id', id)
      .single()

    if (error || !data) {
      console.error('report_runs 단일 조회 에러:', error)
      return res.status(404).json({ message: '리포트를 찾을 수 없습니다.' })
    }

    return res.json(data)
  } catch (e) {
    console.error('GET /report-runs/:id 예외:', e)
    return res
      .status(500)
      .json({ message: 'Server Error', detail: e.toString() })
  }
})

/**
 * GET /report-runs/:id/download, /api/report-runs/:id/download
 * - params.markdown 에 저장된 내용을 md 파일로 내려줌
 */
app.get(
  ['/report-runs/:id/download', '/api/report-runs/:id/download'],
  async (req, res) => {
    const { id } = req.params
    const format = req.query.format || 'md'

    try {
      const { data, error } = await supabase
        .from('report_runs')
        .select('params, created_at')
        .eq('id', id)
        .single()

      if (error || !data) {
        console.error('report_runs 다운로드 조회 에러:', error)
        return res
          .status(404)
          .json({ message: '리포트를 찾을 수 없습니다.', error })
      }

      const params = data.params || {}
      if (format !== 'md') {
        return res
          .status(400)
          .json({ message: '현재는 format=md (마크다운)만 지원합니다.' })
      }

      const markdown =
        params.markdown || params.content || params.body || null

      if (!markdown) {
        return res.status(404).json({
          message:
            '이 리포트에는 markdown 내용이 없습니다. params.markdown을 확인해 주세요.',
        })
      }

      const title =
        params.title || params.report_title || 'AI-리포트'

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${title}.md"`,
      )
      return res.send(markdown)
    } catch (e) {
      console.error('GET /report-runs/:id/download 예외:', e)
      return res.status(500).json({
        message: '다운로드 처리 중 서버 오류가 발생했습니다.',
        detail: e.toString(),
      })
    }
  },
)

/**
 * DELETE /report-runs/:id, /api/report-runs/:id
 */
app.delete(
  ['/report-runs/:id', '/api/report-runs/:id'],
  async (req, res) => {
    const { id } = req.params

    try {
      const { error: outErr } = await supabase
        .from('report_outputs')
        .delete()
        .eq('run_id', id)

      if (outErr) {
        console.error('report_outputs 삭제 에러:', outErr)
      }

      const { error } = await supabase
        .from('report_runs')
        .delete()
        .eq('id', id)

      if (error) {
        console.error('report_runs 삭제 에러:', error)
        return res
          .status(500)
          .json({ message: 'DB Error', detail: error.message || String(error) })
      }

      return res.status(204).send()
    } catch (e) {
      console.error('DELETE /report-runs/:id 예외:', e)
      return res
        .status(500)
        .json({ message: 'Server Error', detail: e.toString() })
    }
  },
)

// -------------------- 서버 시작 --------------------

app.listen(port, () => {
  console.log(`서버 실행중: http://localhost:${port}`)
})
