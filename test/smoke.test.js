'use strict';

// 端到端冒烟测试：内存数据 + 真实 HTTP，覆盖
// 提交 → 发放（消毒/容量校验、争箱冲突与改派）→ 归还（异常区）→ 复核 → 再次借出
const assert = require('assert');
const { createServer } = require('../server');
const { Store } = require('../store');

async function main() {
  const store = new Store(null); // 内存模式，含 4 台种子箱（box-3 消毒已过期）
  const server = createServer(store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async p => (await fetch(base + p)).json();
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json() };
  };

  let passed = 0;
  const ok = (cond, name) => { assert(cond, 'FAIL: ' + name); passed++; console.log('  ✓ ' + name); };

  // 1. 初始库存
  let st = await get('/api/state');
  ok(st.boxes.length === 4, '初始有 4 台冷藏箱');
  ok(st.constants.TEMP_MIN === 2 && st.constants.TEMP_MAX === 8, '温度区间常量 2~8℃');

  // 2. 提交借箱单
  const a = (await post('/api/orders', { nurse: '王护士', vaccine: '流感疫苗', requiredCapacity: 6 })).body;
  ok(a.status === 'pending', '借箱单 A 提交成功，待发放');
  ok((await post('/api/orders', { nurse: '', requiredCapacity: 6 })).status === 400, '缺护士姓名被拒绝');

  // 3. 消毒有效期校验（box-3 已过期）
  let r = await post(`/api/orders/${a.id}/issue`, { boxId: 'box-3', actor: '调度员赵' });
  ok(r.status === 409 && r.body.code === 'DISINFECTION_EXPIRED', '消毒过期箱不得发放');

  // 4. 容量校验（box-1 只有 8L，先造一个 30L 的单）
  const big = (await post('/api/orders', { nurse: '钱护士', requiredCapacity: 30 })).body;
  r = await post(`/api/orders/${big.id}/issue`, { boxId: 'box-4', actor: '调度员赵' });
  ok(r.status === 409 && r.body.code === 'CAPACITY_INSUFFICIENT', '容量不足不得发放');
  await post(`/api/orders/${big.id}/cancel`, { actor: '调度员赵' });

  // 5. 正常发放 A → box-1
  r = await post(`/api/orders/${a.id}/issue`, { boxId: 'box-1', actor: '调度员赵' });
  ok(r.status === 200 && r.body.box.status === 'issued', '借箱单 A 发放成功，box-1 在借');

  // 6. 争箱：B 也要 box-1 → 409 且返回可用箱列表；改派 box-2 成功
  const b = (await post('/api/orders', { nurse: '李护士', requiredCapacity: 6 })).body;
  r = await post(`/api/orders/${b.id}/issue`, { boxId: 'box-1', actor: '调度员赵' });
  ok(r.status === 409 && r.body.code === 'BOX_UNAVAILABLE', '同一箱不能重复发出（B 抢 box-1 被拒）');
  ok(!r.body.extra.availableBoxes.some(x => x.id === 'box-1'), '可用箱列表中不含已占用的 box-1');
  r = await post(`/api/orders/${b.id}/issue`, { boxId: 'box-2', actor: '调度员赵' });
  ok(r.status === 200, 'B 改派 box-2 发放成功');

  // 7. A 归还：温度 9.5℃ 超限 → 异常区
  r = await post(`/api/orders/${a.id}/return`, { sealIntact: true, temperature: 9.5, weight: 3.2, actor: '王护士' });
  ok(r.status === 200 && r.body.box.status === 'exception', '温度超限归还后进入异常区');
  ok(r.body.box.lastReturn.abnormalReasons.includes('温度超限'), '异常原因记录为温度超限');

  // 8. 未经复核不得再借
  const d = (await post('/api/orders', { nurse: '孙护士', requiredCapacity: 6 })).body;
  r = await post(`/api/orders/${d.id}/issue`, { boxId: 'box-1', actor: '调度员赵' });
  ok(r.status === 409, '异常待复核的箱不得再借');

  // 9. 复核放行 → 箱恢复可用，原借单结束，结论留痕
  r = await post('/api/boxes/box-1/review', { decision: 'release', conclusion: '复测温度曲线正常，放行', actor: '复核员周' });
  ok(r.status === 200 && r.body.box.status === 'idle', '复核放行后箱恢复可用');
  ok(r.body.order.status === 'closed' && r.body.order.reviewConclusion === '复测温度曲线正常，放行',
     '原借单 A 结束且保留复核结论');

  // 10. 再次借出：D 拿到 box-1
  r = await post(`/api/orders/${d.id}/issue`, { boxId: 'box-1', actor: '调度员赵' });
  ok(r.status === 200, '复核放行后箱可再次借出（D 借到 box-1）');

  // 11. D 归还：封条破损 → 异常区
  r = await post(`/api/orders/${d.id}/return`, { sealIntact: false, temperature: 5, weight: 3.1, actor: '孙护士' });
  ok(r.body.box.status === 'exception' && r.body.box.lastReturn.abnormalReasons.includes('封条破损'),
     '封条破损归还后进入异常区');

  // 12. 确认异常必须填结论；隔离后不可借；隔离箱可再复核放行
  r = await post('/api/boxes/box-1/review', { decision: 'quarantine', conclusion: '', actor: '复核员周' });
  ok(r.status === 400, '隔离必须填写异常结论');
  r = await post('/api/boxes/box-1/review', { decision: 'quarantine', conclusion: '封条破损，待厂家检测', actor: '复核员周' });
  ok(r.status === 200 && r.body.box.status === 'quarantined', '确认异常后箱隔离');
  const e = (await post('/api/orders', { nurse: '吴护士', requiredCapacity: 6 })).body;
  r = await post(`/api/orders/${e.id}/issue`, { boxId: 'box-1', actor: '调度员赵' });
  ok(r.status === 409, '隔离中的箱不得借出');
  r = await post('/api/boxes/box-1/review', { decision: 'release', conclusion: '厂家检测合格，恢复使用', actor: '复核员周' });
  ok(r.body.box.status === 'idle', '隔离箱复核后可放行');

  // 13. B 正常归还 → 待复核（非异常区），同样须复核后才能再借
  r = await post(`/api/orders/${b.id}/return`, { sealIntact: true, temperature: 4.2, weight: 4.0, actor: '李护士' });
  ok(r.body.box.status === 'pending_review', '正常归还进入待复核（非异常区）');
  r = await post(`/api/orders/${e.id}/issue`, { boxId: 'box-2', actor: '调度员赵' });
  ok(r.status === 409, '待复核的箱不得再借');
  r = await post('/api/boxes/box-2/review', { decision: 'release', conclusion: '', actor: '复核员周' });
  ok(r.body.box.status === 'idle', '正常归还复核放行');
  r = await post(`/api/orders/${e.id}/issue`, { boxId: 'box-2', actor: '调度员赵' });
  ok(r.status === 200, '放行后 E 借到 box-2');

  // 14. 留痕：每次交接时间与异常结论都在事件流中
  st = await get('/api/state');
  const types = st.events.map(ev => ev.type);
  ok(['order_submitted', 'box_issued', 'box_returned', 'box_reviewed', 'order_cancelled']
    .every(t => types.includes(t)), '五类事件均有记录');
  ok(st.events.every(ev => ev.time), '每条事件都有交接时间');
  ok(st.events.some(ev => ev.detail.includes('封条破损，待厂家检测')), '异常结论保留在记录中');
  const orderA = st.orders.find(o => o.id === a.id);
  ok(orderA.status === 'closed' && orderA.issuedAt && orderA.returnedAt && orderA.closedAt,
     '借箱单 A 全流程时间齐全（发放/归还/结束）');

  console.log(`\n全部通过：${passed} 项断言`);
  server.close();
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
