// back/prompts.js

/**
 * 1. 텍스트 구조화 프롬프트
 *    - raw_text 를 날짜 → 학생 → 활동 순서로 나눈 뒤
 *      각 활동을 1개의 record 로 만들어 records 배열에 담는다.
 */
const PDF_TXT_EXTRACTION_PROMPT = `
너는 특수교육 활동 기록을 구조화하는 전문가야.

[역할]
- 입력 raw_text(활동일지 전체 텍스트)를 날짜 → 학생 → 활동 순서로 구조화한 뒤,
  각 "활동"을 1개의 record 로 평탄화(flatten)해서 records 배열에 담아.
- 이 records 는 웹서비스 UploadPage의 AI 분석 결과 패널에서 바로 사용될 거야.

[처리 순서]
1. raw_text 를 먼저 날짜별로 구분해.
   - "2025-12-01", "2025. 12. 1.", "2025년 12월 1일" 과 같은 표현을 모두 인식해 YYYY-MM-DD 로 통일해.
   - 날짜가 명시되지 않은 활동은 파일의 문맥상 가장 자연스러운 날짜 한 개를 추정해서 넣어.
2. 각 날짜 안에서 학생별로 활동을 나눠.
   - 이름(또는 이니셜, 약칭 등)을 기준으로 학생을 구분해.
   - 이름이 전혀 보이지 않는다면 student_name 을 null 로 두고, teacher_notes 에만 상황을 남겨.
3. 각 학생 안에서 활동 단위로 다시 나눠.
   - 활동명은 "○○ 활동", "○○ 재배", "○○ 수확" 등 문장에서 자연스럽게 한 줄 제목을 뽑아.

[레코드 필드 정의]
각 활동에 대해 아래 정보를 채워서 하나의 record 로 만들어.
- date           : 그 활동이 이루어진 날짜(YYYY-MM-DD 문자열)
- student_name   : 학생 이름(또는 이니셜). 없으면 null
- activity_title : 활동명(짧은 제목, 문자열)
- activity_type  : 아래 다섯 가지 중 하나
                   "수확", "파종", "관리", "관찰", "기타"
- minutes        : 활동에 사용된 시간(정수, 분 단위). 시간이 보이지 않으면 0.
- emotions       : 이 활동에서 학생이 보인 감정을 나타내는 문자열 배열
                   예) ["즐거움", "호기심"], ["불안", "긴장"]
                   · 추측하지 말고, 텍스트에 근거한 감정 단어만 사용해.
- teacher_notes  : 교사가 나중에 상세 기록에 그대로 붙여넣을 수 있는 관찰/특이사항(짧은 문장)

[출력 형식]
1. 출력은 **순수 JSON 한 개**만 허용된다.
2. JSON 최상단에는 항상 "records" 키 하나만 존재해야 한다.
3. records 는 위에서 정의한 record 객체들의 배열이다.
4. JSON 앞뒤에 다른 텍스트(설명, 인사말, 코드블록, 주석 등)를 절대 붙이지 마라.

[출력 JSON 예시]
{
  "records": [
    {
      "date": "2025-03-10",
      "student_name": "라온",
      "activity_title": "농장 첫 둘러보기",
      "activity_type": "관찰",
      "minutes": 0,
      "emotions": ["긴장", "설렘"],
      "teacher_notes": "처음에는 긴장했지만 농장을 둘러보며 점점 설렘이 커지는 모습."
    }
  ]
}

[입력 raw_text]
{raw_text}
`;

/**
 * 2. 리포트 프롬프트 생성기
 *    - category: 코드(full/emotion/activity_ratio/ability_growth) 또는 한글 라벨(전체 리포트/감정 변화/활동 비율 변화/능력 성장 곡선 등)
 *    - purpose: '학부모 상담용', '학교 제출용' 등
 *    - tone: 자연어 톤 설명
 */
const GET_REPORT_PROMPT = (category, purpose, tone) => {
  const safeCategory = (category || '').trim();
  const normalized = safeCategory.toLowerCase();

  // 공통 기본 지침
  const baseInstruction = `
당신은 특수교육 전문가입니다. 입력된 통계 데이터와 활동 샘플을 바탕으로 **Markdown 형식**의 리포트를 작성해 주세요.

**[작성 지침]**
1. **형식**: Markdown (제목 #, 소제목 ## 사용).
2. **톤앤매너**: 목적은 '${purpose}', 어조는 '${tone}'입니다.
3. **데이터 준수**: 입력된 JSON 데이터에 기반해서만 서술하세요. 추측성 서술은 지양하세요.
  `;

  let specificInstruction = "";
  let structureGuide = "";

  // 카테고리 매칭 (코드 + 한글 라벨 둘 다 지원)
  if (
    normalized === 'emotion' ||
    safeCategory === '감정 변화'
  ) {
    specificInstruction = `
**[분석 초점: 감정 변화]**
- 기간 동안 학생의 정서적 흐름(안정감, 불안 등)이 어떻게 변화했는지 분석하세요.
- 특정 활동이나 시간대, 환경 요인(Trigger)과 감정의 상관관계를 파악하세요.
- 주요 감정이 나타난 사례와 그 맥락을 중점적으로 서술하세요.
    `;
    structureGuide = `
# 1. 감정 변화 요약
# 2. 주요 감정 흐름 분석
(기간 초반 vs 후반 변화 등)
# 3. 감정 유발 요인 (Trigger) 및 반응
# 4. 정서적 안정을 위한 제언
# 5. 마무리
    `;
  } else if (
    normalized === 'activity_ratio' ||
    safeCategory === '활동 비율 변화' ||
    safeCategory === '활동 유동 변화'
  ) {
    specificInstruction = `
**[분석 초점: 활동 비율/참여 패턴 변화]**
- 학생의 활동 참여 패턴이 어떻게 변화했는지(특정 활동 집중, 다양성 증가 등) 분석하세요.
- 활동의 전환(전이) 과정에서의 적응도와 유연성을 평가하세요.
- 선호 활동과 비선호 활동 간의 참여 시간 변화 추이를 서술하세요.
    `;
    structureGuide = `
# 1. 활동 패턴 요약
# 2. 활동 유형별 참여 변화
(시간 비중 변화, 새로운 활동 시도 등)
# 3. 활동 전이 및 참여 태도 분석
# 4. 활동 다양성 증진을 위한 제언
# 5. 마무리
    `;
  } else if (
    normalized === 'ability_growth' ||
    safeCategory === '활동 능력 변화' ||
    safeCategory === '능력 성장 곡선'
  ) {
    specificInstruction = `
**[분석 초점: 활동 능력 변화]**
- 활동 수행 수준(매우 우수~도전적)의 변화 추이를 분석하세요.
- 이전에 어려워했던(도전적) 활동에서 성취를 보인 '성장 사례'를 찾으세요.
- 영역별(인지, 운동, 사회성 등) 능력 발달의 불균형이나 특이점을 서술하세요.
    `;
    structureGuide = `
# 1. 능력 성장 요약
# 2. 영역별 수행 능력 변화 추이
(성취도가 향상된 영역 위주)
# 3. 주요 성취 사례 (Success Story)
# 4. 향후 발달 목표 및 지도 방안
# 5. 마무리
    `;
  } else {
    // full / 전체 리포트 (기본)
    specificInstruction = `
**[분석 초점: 종합 보고서]**
- 학생의 학교생활 전반(감정, 행동, 학습, 사회성)을 균형 있게 요약하세요.
- 강점 위주로 서술하되, 지원이 필요한 부분도 명확히 명시하세요.
- 모든 영역(감정, 활동, 능력)을 아우르는 통합적 관점을 유지하세요.
    `;
    structureGuide = `
# 1. 기본 정보
# 2. 전체 개요
# 3. 강점과 긍정적 변화
# 4. 도움이 필요한 영역
# 5. 감정 및 행동 패턴
# 6. 활동별 능력 분석
# 7. 지원 제안 및 다음 단계
# 8. 마무리 문장
    `;
  }

  // {input_json} 자리에 서버에서 JSON 을 그대로 넣어줄 것임
  return `
${baseInstruction}

${specificInstruction}

**[입력 데이터]**
{input_json}

**[출력 리포트 목차 구조]**
${structureGuide}
  `;
};

module.exports = {
  PDF_TXT_EXTRACTION_PROMPT,
  GET_REPORT_PROMPT,
};
