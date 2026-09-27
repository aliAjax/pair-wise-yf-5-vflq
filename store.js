'use strict';

const fs = require('fs');

// 冷藏疫苗常规储运温度区间（℃）
const TEMP_MIN = 2;
const TEMP_MAX = 8;

const BOX_STATUS = {
  IDLE: 'idle',                    // 可用（已复核放行或初始）
  ISSUED: 'issued',                // 在借
  PENDING_REVIEW: 'pending_review',// 已归还，待复核
  EXCEPTION: 'exception',          // 异常区，待复核
  QUARANTINED: 'quarantined',      // 复核确认异常，隔离中
};

const ORDER_STATUS = {
  PENDING: 'pending',     // 待发放
  ISSUED: 'issued',       // 在借
  RETURNED: 'returned',   // 已归还，待复核
  CLOSED: 'closed',       // 已结束（复核完成）
  CANCELLED: 'cancelled', // 已取消
};

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function seedState() {
  const day = 24 * 3600 * 1000;
  const defs = [
    { code: 'BX-001', capacity: 8, days: 7 },
    { code: 'BX-002', capacity: 12, days: 3 },
    { code: 'BX-003', capacity: 5, days: -1 }, // 消毒已过期，用于演示拦截
    { code: 'BX-004', capacity: 20, days: 14 },
  ];
  const boxes = defs.map((d, i) => ({
    id: 'box-' + (i + 1),
    code: d.code,
    capacity: d.capacity,
    disinfectValidUntil: new Date(Date.now() + d.days * day).toISOString(),
    status: BOX_STATUS.IDLE,
    currentOrderId: null,
    lastReturn: null,
    lastReview: null,
  }));
  return { seq: 1, boxes, orders: [], events: [] };
}

class Store {
  constructor(file) {
    this.file = file || null;
    if (this.file && fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.state = seedState();
      this.save();
    }
  }

  save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextId(prefix) {
    return prefix + '-' + String(this.state.seq++).padStart(4, '0');
  }

  log(type, opts) {
    const ev = Object.assign(
      { id: this.nextId('ev'), time: nowIso(), type, boxId: null, orderId: null, actor: '', detail: '' },
      opts
    );
    this.state.events.push(ev);
    return ev;
  }

  findOrder(id) { return this.state.orders.find(o => o.id === id); }
  findBox(id) { return this.state.boxes.find(b => b.id === id); }

  availableBoxes() {
    return this.state.boxes
      .filter(b => b.status === BOX_STATUS.IDLE)
      .map(b => ({ id: b.id, code: b.code, capacity: b.capacity, disinfectValidUntil: b.disinfectValidUntil }));
  }

  disinfectionValid(box) {
    return new Date(box.disinfectValidUntil).getTime() >= Date.now();
  }

  // 护士提交借箱单
  createOrder(input) {
    const nurse = String(input.nurse || '').trim();
    const vaccine = String(input.vaccine || '').trim();
    const note = String(input.note || '').trim();
    const requiredCapacity = Number(input.requiredCapacity);
    if (!nurse) throw new ApiError(400, 'NURSE_REQUIRED', '请填写护士姓名');
    if (!Number.isFinite(requiredCapacity) || requiredCapacity <= 0) {
      throw new ApiError(400, 'CAPACITY_INVALID', '所需容量必须为正数');
    }
    const order = {
      id: this.nextId('JXD'),
      nurse, vaccine, note, requiredCapacity,
      status: ORDER_STATUS.PENDING,
      boxId: null,
      createdAt: nowIso(),
      issuedAt: null,
      returnedAt: null,
      closedAt: null,
      returnRecord: null,
      reviewDecision: null,
      reviewConclusion: null,
    };
    this.state.orders.push(order);
    this.log('order_submitted', {
      orderId: order.id, actor: nurse,
      detail: `申请冷藏箱，需 ${requiredCapacity}L` + (vaccine ? `，疫苗：${vaccine}` : ''),
    });
    this.save();
    return order;
  }

  // 调度员确认发放。Node 单线程同步执行，检查与占用是原子的：先确认者占用整箱，
  // 后来的单拿到 409 与当前可用箱列表，由调度员改派。
  issueOrder(orderId, boxId, actor) {
    const order = this.findOrder(orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '借箱单不存在');
    if (order.status !== ORDER_STATUS.PENDING) {
      throw new ApiError(409, 'ORDER_NOT_PENDING', '该借箱单当前不可发放');
    }
    const box = this.findBox(boxId);
    if (!box) throw new ApiError(404, 'BOX_NOT_FOUND', '冷藏箱不存在');
    if (box.status !== BOX_STATUS.IDLE) {
      throw new ApiError(409, 'BOX_UNAVAILABLE',
        `冷藏箱 ${box.code} 已被占用或待复核，请改派其他可用箱`,
        { availableBoxes: this.availableBoxes() });
    }
    if (!this.disinfectionValid(box)) {
      throw new ApiError(409, 'DISINFECTION_EXPIRED', `冷藏箱 ${box.code} 已过消毒有效期，不得发放`);
    }
    if (box.capacity < order.requiredCapacity) {
      throw new ApiError(409, 'CAPACITY_INSUFFICIENT',
        `冷藏箱 ${box.code} 容量 ${box.capacity}L 小于所需 ${order.requiredCapacity}L`);
    }
    box.status = BOX_STATUS.ISSUED;
    box.currentOrderId = order.id;
    order.status = ORDER_STATUS.ISSUED;
    order.boxId = box.id;
    order.issuedAt = nowIso();
    this.log('box_issued', {
      boxId: box.id, orderId: order.id, actor: actor || '调度员',
      detail: `冷藏箱 ${box.code} 发放给 ${order.nurse}`,
    });
    this.save();
    return { order, box };
  }

  // 归还登记：封条、温度、重量；温度超限或封条破损转入异常区
  returnOrder(orderId, input, actor) {
    const order = this.findOrder(orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '借箱单不存在');
    if (order.status !== ORDER_STATUS.ISSUED) {
      throw new ApiError(409, 'ORDER_NOT_ISSUED', '该借箱单不在借出状态');
    }
    const sealIntact = input.sealIntact === true || input.sealIntact === 'true' ||
      input.sealIntact === 1 || input.sealIntact === '1';
    const temperature = Number(input.temperature);
    const weight = Number(input.weight);
    if (!Number.isFinite(temperature)) throw new ApiError(400, 'TEMP_INVALID', '请填写归还温度');
    if (!Number.isFinite(weight) || weight <= 0) throw new ApiError(400, 'WEIGHT_INVALID', '请填写归还重量');
    const box = this.findBox(order.boxId);
    if (!box) throw new ApiError(500, 'BOX_MISSING', '关联冷藏箱缺失');

    const reasons = [];
    if (temperature < TEMP_MIN || temperature > TEMP_MAX) reasons.push('温度超限');
    if (!sealIntact) reasons.push('封条破损');

    const at = nowIso();
    const record = { sealIntact, temperature, weight, at, abnormalReasons: reasons };
    box.status = reasons.length ? BOX_STATUS.EXCEPTION : BOX_STATUS.PENDING_REVIEW;
    box.lastReturn = record;
    order.status = ORDER_STATUS.RETURNED;
    order.returnedAt = at;
    order.returnRecord = record;
    this.log('box_returned', {
      boxId: box.id, orderId: order.id, actor: actor || order.nurse,
      detail: `封条${sealIntact ? '完好' : '破损'}，温度 ${temperature}℃，重量 ${weight}kg` +
        (reasons.length ? `，异常：${reasons.join('、')}，转入异常区` : '，待复核'),
    });
    this.save();
    return { order, box };
  }

  // 复核：放行（恢复可借）或确认异常（隔离）。复核后原借单结束，结论留痕。
  reviewBox(boxId, input, actor) {
    const box = this.findBox(boxId);
    if (!box) throw new ApiError(404, 'BOX_NOT_FOUND', '冷藏箱不存在');
    if (![BOX_STATUS.PENDING_REVIEW, BOX_STATUS.EXCEPTION, BOX_STATUS.QUARANTINED].includes(box.status)) {
      throw new ApiError(409, 'BOX_NOT_REVIEWABLE', '该冷藏箱当前无需复核');
    }
    const decision = input.decision;
    if (!['release', 'quarantine'].includes(decision)) {
      throw new ApiError(400, 'DECISION_INVALID', '复核结论必须为放行或隔离');
    }
    const conclusion = String(input.conclusion || '').trim();
    if (decision === 'quarantine' && !conclusion) {
      throw new ApiError(400, 'CONCLUSION_REQUIRED', '确认异常隔离时必须填写异常结论');
    }
    const at = nowIso();
    box.status = decision === 'release' ? BOX_STATUS.IDLE : BOX_STATUS.QUARANTINED;
    box.lastReview = {
      decision,
      conclusion: conclusion || (decision === 'release' ? '复核合格，放行' : ''),
      at, by: actor || '复核员',
    };
    const order = box.currentOrderId ? this.findOrder(box.currentOrderId) : null;
    if (order && order.status === ORDER_STATUS.RETURNED) {
      order.status = ORDER_STATUS.CLOSED;
      order.closedAt = at;
      order.reviewDecision = decision;
      order.reviewConclusion = box.lastReview.conclusion;
    }
    box.currentOrderId = null;
    this.log('box_reviewed', {
      boxId: box.id, orderId: order ? order.id : null, actor: actor || '复核员',
      detail: (decision === 'release' ? '复核放行，冷藏箱恢复可借' : '确认异常，冷藏箱隔离') +
        (box.lastReview.conclusion ? `：${box.lastReview.conclusion}` : ''),
    });
    this.save();
    return { box, order };
  }

  cancelOrder(orderId, actor) {
    const order = this.findOrder(orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '借箱单不存在');
    if (order.status !== ORDER_STATUS.PENDING) {
      throw new ApiError(409, 'ORDER_NOT_PENDING', '仅待发放的借箱单可取消');
    }
    order.status = ORDER_STATUS.CANCELLED;
    order.closedAt = nowIso();
    this.log('order_cancelled', { orderId: order.id, actor: actor || '调度员', detail: `借箱单 ${order.id} 已取消` });
    this.save();
    return order;
  }
}

module.exports = { Store, ApiError, BOX_STATUS, ORDER_STATUS, TEMP_MIN, TEMP_MAX };
