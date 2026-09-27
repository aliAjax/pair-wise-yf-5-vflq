'use strict';
/**
 * 社区药房冷藏疫苗箱借还管理
 * 流程：护士提交借箱单 → 调度员确认发放（按消毒有效期+容量，先确认先占整箱，冲突需改派）
 *      → 归还登记（封条/温度/重量，超限或破损进异常区）→ 复核（未复核不得再借）
 *      → 复核放行后原借单结束，箱子可再次借出。异常结论与每次交接时间全部留痕。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const TEMP_MIN = 2; // 疫苗冷链温度下限 °C
const TEMP_MAX = 8; // 疫苗冷链温度上限 °C

// ---------------- 数据层（JSON 文件持久化） ----------------
function seed() {
  return {
    seq: 1,
    boxes: [
      { id: 'B001', code: 'BX-001', capacity: 20, disinfectionValidUntil: '2026-10-15', status: 'available', currentOrderId: null },
      { id: 'B002', code: 'BX-002', capacity: 10, disinfectionValidUntil: '2026-09-20', status: 'available', currentOrderId: null }, // 消毒已过期，不可发放
      { id: 'B003', code: 'BX-003', capacity: 20, disinfectionValidUntil: '2026-10-01', status: 'available', currentOrderId: null },
      { id: 'B004', code: 'BX-004', capacity: 5,  disinfectionValidUntil: '2026-12-31', status: 'available', currentOrderId: null },
    ],
    orders: [],   // 借箱单
    returns: [],  // 归还记录
    reviews: [],  // 复核记录（含异常结论，永久保留）
    events: [],   // 交接时间流水
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    const d = seed();
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
    return d;
  }
}

let db = load();
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
const nid = (p) => `${p}${String(db.seq++).padStart(4, '0')}`;

function logEvent(type, message, refs = {}) {
  db.events.unshift({ id: nid('E'), time: now(), type, message, ...refs });
}

// 箱是否可发放：空闲 + 容量满足 + 消毒在有效期内
function boxIssuable(box, requiredCapacity) {
  return box.status === 'available'
    && box.capacity >= requiredCapacity
    && box.disinfectionValidUntil >= today();
}

function availableBoxesFor(requiredCapacity) {
  return db.boxes
    .filter((b) => boxIssuable(b, requiredCapacity))
    .map((b) => ({ id: b.id, code: b.code, capacity: b.capacity, disinfectionValidUntil: b.disinfectionValidUntil }));
}

// ---------------- 业务操作 ----------------
// 1. 护士提交借箱单
function submitOrder({ nurse, requiredCapacity, note }) {
  nurse = String(nurse || '').trim();
  requiredCapacity = Number(requiredCapacity);
  if (!nurse) return { status: 400, body: { message: '请填写护士姓名' } };
  if (!Number.isFinite(requiredCapacity) || requiredCapacity <= 0) {
    return { status: 400, body: { message: '请填写有效的需求容量' } };
  }
  const order = {
    id: nid('O'), nurse, requiredCapacity, note: String(note || '').trim(),
    status: 'pending', boxId: null, boxCode: null, dispatcher: null,
    submittedAt: now(), issuedAt: null, returnedAt: null, closedAt: null,
  };
  db.orders.unshift(order);
  logEvent('提交', `护士 ${nurse} 提交借箱单 ${order.id}（需求容量 ${requiredCapacity}L）`, { orderId: order.id });
  save();
  return { status: 201, body: { order } };
}

// 2. 调度员确认发放（占整箱）。检查与占用在同一个同步块内完成，同一箱不会被重复发出。
function confirmOrder(orderId, { boxId, dispatcher }) {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) return { status: 404, body: { message: '借箱单不存在' } };
  if (order.status !== 'pending') return { status: 409, body: { message: '该单已处理，请刷新' } };

  const box = db.boxes.find((b) => b.id === boxId);
  if (!box) return { status: 404, body: { message: '箱子不存在' } };

  if (!boxIssuable(box, order.requiredCapacity)) {
    // 被别的单先确认 / 消毒过期 / 容量不足 → 要求改派
    const reason = box.status !== 'available' ? `箱 ${box.code} 刚被其他借单确认占用`
      : box.disinfectionValidUntil < today() ? `箱 ${box.code} 消毒已过有效期`
      : `箱 ${box.code} 容量不足`;
    logEvent('改派提示', `借箱单 ${order.id} 确认失败：${reason}，需改派其他可用箱`, { orderId: order.id, boxId: box.id });
    save();
    return { status: 409, body: { message: `${reason}，请改派`, availableBoxes: availableBoxesFor(order.requiredCapacity) } };
  }

  box.status = 'issued';
  box.currentOrderId = order.id;
  order.status = 'issued';
  order.boxId = box.id;
  order.boxCode = box.code;
  order.dispatcher = String(dispatcher || '').trim() || '调度员';
  order.issuedAt = now();
  logEvent('发放', `调度员 ${order.dispatcher} 确认借箱单 ${order.id}，发出箱 ${box.code}（整箱占用）`, { orderId: order.id, boxId: box.id });
  save();
  return { status: 200, body: { order } };
}

// 3. 归还登记：封条、温度、重量；温度超限或封条破损 → 异常区
function returnOrder(orderId, { sealIntact, temperature, weight, returnedBy }) {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) return { status: 404, body: { message: '借箱单不存在' } };
  if (order.status !== 'issued') return { status: 409, body: { message: '该单不在借出状态' } };

  temperature = Number(temperature);
  weight = Number(weight);
  if (!Number.isFinite(temperature)) return { status: 400, body: { message: '请填写归还温度' } };
  if (!Number.isFinite(weight) || weight <= 0) return { status: 400, body: { message: '请填写有效重量' } };

  const box = db.boxes.find((b) => b.id === order.boxId);
  const reasons = [];
  if (!sealIntact) reasons.push('封条破损');
  if (temperature < TEMP_MIN || temperature > TEMP_MAX) reasons.push(`温度 ${temperature}°C 超出 ${TEMP_MIN}–${TEMP_MAX}°C 冷链范围`);
  const abnormal = reasons.length > 0;

  box.status = abnormal ? 'exception' : 'pending_review';
  order.status = 'returned';
  order.returnedAt = now();

  const rec = {
    id: nid('R'), orderId: order.id, boxId: box.id, boxCode: box.code,
    sealIntact: !!sealIntact, temperature, weight, abnormal, reasons,
    returnedBy: String(returnedBy || '').trim() || order.nurse, returnedAt: order.returnedAt,
  };
  db.returns.unshift(rec);
  logEvent(abnormal ? '归还异常' : '归还',
    `借箱单 ${order.id} 归还箱 ${box.code}：封条${sealIntact ? '完好' : '破损'}、温度 ${temperature}°C、重量 ${weight}kg` +
    (abnormal ? ` → 进入异常区（${reasons.join('；')}）` : ' → 待复核'),
    { orderId: order.id, boxId: box.id });
  save();
  return { status: 200, body: { return: rec, abnormal } };
}

// 4. 复核：放行 → 箱恢复可用、原借单结束；继续隔离 → 留在异常区。未经复核的箱子不得再借。
function reviewBox(boxId, { reviewer, decision, conclusion }) {
  const box = db.boxes.find((b) => b.id === boxId);
  if (!box) return { status: 404, body: { message: '箱子不存在' } };
  if (box.status !== 'pending_review' && box.status !== 'exception') {
    return { status: 409, body: { message: '该箱当前无需复核' } };
  }
  reviewer = String(reviewer || '').trim();
  conclusion = String(conclusion || '').trim();
  if (!reviewer) return { status: 400, body: { message: '请填写复核人' } };
  if (!conclusion) return { status: 400, body: { message: '请填写复核结论' } };
  if (!['release', 'hold'].includes(decision)) return { status: 400, body: { message: '无效的复核决定' } };

  const order = db.orders.find((o) => o.id === box.currentOrderId);
  const rec = {
    id: nid('V'), boxId: box.id, boxCode: box.code,
    orderId: order ? order.id : null,
    returnId: (db.returns.find((r) => r.boxId === box.id && r.orderId === (order && order.id)) || {}).id || null,
    reviewer, decision, conclusion, reviewedAt: now(),
  };
  db.reviews.unshift(rec);

  if (decision === 'release') {
    box.status = 'available';
    box.currentOrderId = null;
    if (order && order.status === 'returned') {
      order.status = 'closed';
      order.closedAt = now();
    }
    logEvent('复核放行', `箱 ${box.code} 复核放行（${reviewer}：${conclusion}），借箱单 ${order ? order.id : '-'} 结束，箱子可再次借出`, { orderId: rec.orderId, boxId: box.id });
  } else {
    box.status = 'exception';
    logEvent('复核隔离', `箱 ${box.code} 复核决定继续隔离（${reviewer}：${conclusion}），暂不可借出`, { orderId: rec.orderId, boxId: box.id });
  }
  save();
  return { status: 200, body: { review: rec } };
}

// ---------------- HTTP 服务 ----------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('请求体不是有效 JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(200, { ...db, meta: { tempMin: TEMP_MIN, tempMax: TEMP_MAX, today: today() } });
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const r = submitOrder(await readBody(req));
      return send(r.status, r.body);
    }
    let m = url.pathname.match(/^\/api\/orders\/([^/]+)\/confirm$/);
    if (req.method === 'POST' && m) {
      const r = confirmOrder(m[1], await readBody(req));
      return send(r.status, r.body);
    }
    m = url.pathname.match(/^\/api\/orders\/([^/]+)\/return$/);
    if (req.method === 'POST' && m) {
      const r = returnOrder(m[1], await readBody(req));
      return send(r.status, r.body);
    }
    m = url.pathname.match(/^\/api\/boxes\/([^/]+)\/review$/);
    if (req.method === 'POST' && m) {
      const r = reviewBox(m[1], await readBody(req));
      return send(r.status, r.body);
    }

    // 静态页面
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    send(404, { message: 'Not Found' });
  } catch (err) {
    send(400, { message: err.message || '请求处理失败' });
  }
});

server.listen(PORT, () => console.log(`疫苗冷藏箱借还管理已启动：http://localhost:${PORT}`));
