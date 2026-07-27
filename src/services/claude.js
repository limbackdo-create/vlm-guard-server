const { cfg } = require('../config');

/**
 * 현장 지식(RAG)을 프롬프트 블록으로 만든다.
 * site.knowledge / site.rules / 최근 이벤트를 지금 상황에 맞게 골라 넣는다.
 */
function knowledgeBlock(site, recentEvents) {
  let out = '';

  const lines = String(site?.knowledge || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length) {
    out += '\n[이 장소에 대해 알아둘 것]\n';
    lines.forEach((l) => { out += '- ' + l + '\n'; });
    out += '위 내용에 해당하는 상황은 정상으로 판단한다.\n';
  }

  const hour = new Date().getHours();
  const rules = (site?.rules || []).filter((r) => {
    const f = Number(r.from), t = Number(r.to);
    if (isNaN(f) || isNaN(t)) return false;
    return f <= t ? (hour >= f && hour < t) : (hour >= f || hour < t);
  });
  if (rules.length) {
    out += `\n[지금 시각(${hour}시)에 적용되는 규칙]\n`;
    rules.forEach((r) => { out += '- ' + r.text + '\n'; });
    out += '이 규칙에 어긋나면 상태를 주의 또는 경고로 올린다.\n';
  }

  if (recentEvents && recentEvents.length) {
    out += '\n[최근 감지 기록]\n';
    recentEvents.forEach((e) => {
      const t = new Date(e.created_at).toTimeString().slice(0, 8);
      out += `- ${t} ${(e.situation || e.level || '').slice(0, 45)}\n`;
    });
    out += '같은 대상이 짧은 시간에 반복해서 나타나면 배회로 보고 주의로 판단한다.\n';
  }

  return out;
}

/** 일반 감시용 시스템 프롬프트 */
function buildWatchSystem(site, recentEvents, reason) {
  const targets = site?.targets || [];
  let s =
    '너는 매장·현장 감시 카메라의 AI 분석관이다. 움직임이 감지되어 촬영된 정지 이미지를 보고 상황을 판단한다.\n' +
    '반드시 아래 형식으로만, 아주 간결하게 답한다.\n' +
    '상태: 정상 | 주의 | 경고  (셋 중 하나만)\n' +
    '상황: 지금 무슨 일이 일어나는지 한 문장\n' +
    '대상: 무엇이 보이는지 (사람 수, 물체 등. 불분명하면 "불명")\n' +
    '조치: 필요한 조치 한 줄 (없으면 "불필요")\n';

  if (targets.length) {
    s += '\n[중점 감시 대상] 다음 항목을 특히 주의 깊게 확인한다:\n';
    targets.forEach((n, i) => { s += `${i + 1}. ${n}\n`; });
    s += '위 항목 중 하나라도 발견되면 상태를 반드시 "주의" 또는 "경고"로 하고, ' +
         '상황 줄 맨 앞에 [발견: 항목명] 을 붙인다.\n';
  }

  s += knowledgeBlock(site, recentEvents);

  s += '\n판단 기준 — 정상: 평범한 방문·통행·일상 활동이며 위 감시 대상이 없음. ' +
       '주의: 감시 대상으로 의심되는 것이 있거나 애매한 상황. ' +
       '경고: 감시 대상이 명확히 확인되거나 즉시 확인이 필요한 상황.\n' +
       '사람의 외모·신원을 추측하지 말고 행동과 상황만 서술한다. ' +
       '화면이 어둡거나 불분명하면 상태는 정상으로 두고 상황에 그 사실을 적는다.';

  return s;
}

/** 출입 카운터용 시스템 프롬프트 (사람 확인 + 이상 판정 동시) */
function buildDoorSystem(site, recentEvents) {
  const targets = site?.targets || [];
  let s =
    '너는 출입구 감시 AI다. 사진을 보고 두 가지를 동시에 판단한다.\n' +
    '(1) 사람이 지나가는지와 인원 수\n(2) 이상 상황이 있는지\n';
  if (targets.length) s += '이상 상황 판단 시 다음을 특히 확인한다: ' + targets.join(', ') + '\n';
  s += knowledgeBlock(site, recentEvents);
  s += '\n반드시 아래 한 줄 형식으로만 답한다. 다른 말은 하지 않는다.\n' +
       '사람:있음|없음, 인원:숫자, 종류:사람|동물|물체|불명, 상태:정상|주의|경고, 상황:짧은 한 문장\n' +
       '평범하게 드나드는 것은 반드시 "정상"으로 한다. 사람의 외모·신원은 추측하지 않는다.';
  return s;
}

const ASK = {
  motion: '움직임이 감지되어 촬영된 화면입니다. 상황을 판단해주세요.',
  flame: '화면에 갑자기 밝은 빛이 나타나 촬영된 장면입니다. 불꽃(라이터·촛불·화재)인지, ' +
         '아니면 조명·손전등·화면빛 같은 일반적인 빛인지 구분해서 판단해주세요. ' +
         '불꽃이 맞으면 상태를 경고로 하고, 단순 조명이면 정상으로 하세요.',
  small: '움직임이 감지되어 촬영된 화면입니다. 작은 벌레나 이물질이 있는지 바닥과 구석을 자세히 살펴 판단해주세요.',
  door: '출입 상황을 판단해주세요.',
};

/** Claude 호출 */
async function callClaude({ base64, mimeType, system, userText, fast, maxTokens }) {
  const model = fast === false ? cfg.anthropic.modelAccurate : cfg.anthropic.modelFast;

  const res = await fetch(cfg.anthropic.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropic.apiKey,
      'anthropic-version': cfg.anthropic.version,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 280,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64 } },
          { type: 'text', text: userText },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let msg = t;
    try { msg = JSON.parse(t).error.message; } catch (_) {}
    const err = new Error('AI 분석 실패 (' + res.status + '): ' + String(msg).slice(0, 200));
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const text = (json.content || []).map((c) => c.text).filter(Boolean).join('\n').trim();
  const usage = json.usage || {};
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;

  // 실제 사용 토큰으로 원가 계산
  const pIn = fast === false ? cfg.price.inAcc : cfg.price.inFast;
  const pOut = fast === false ? cfg.price.outAcc : cfg.price.outFast;
  const costKrw = ((inTok / 1e6) * pIn + (outTok / 1e6) * pOut) * cfg.price.usdKrw;

  return { text, model, inputTokens: inTok, outputTokens: outTok, costKrw, usedModel: model };
}

/** 감시 응답 파싱 */
function parseWatch(text) {
  const head = (text.split('\n')[0] || '');
  let level = 'normal';
  if (head.includes('경고')) level = 'alert';
  else if (head.includes('주의')) level = 'warn';

  let situation = '';
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('상황')) { situation = l.replace(/^상황\s*[:：]\s*/, '').slice(0, 120); break; }
  }
  return { level, situation };
}

/** 출입 응답 파싱 */
function parseDoor(text) {
  const isPerson = /사람\s*[:：]?\s*있음/.test(text);
  const m = text.match(/인원\s*[:：]?\s*(\d+)/);
  const kindM = text.match(/종류\s*[:：]?\s*(사람|동물|물체|불명)/);
  let level = 'normal';
  if (/상태\s*[:：]?\s*경고/.test(text)) level = 'alert';
  else if (/상태\s*[:：]?\s*주의/.test(text)) level = 'warn';
  const sitM = text.match(/상황\s*[:：]?\s*([^\n]+)/);
  return {
    isPerson,
    count: m ? parseInt(m[1], 10) : 1,
    kind: kindM ? kindM[1] : '',
    level,
    situation: sitM ? sitM[1].trim().slice(0, 120) : '',
  };
}

module.exports = {
  buildWatchSystem, buildDoorSystem, callClaude, parseWatch, parseDoor, knowledgeBlock, ASK,
};
