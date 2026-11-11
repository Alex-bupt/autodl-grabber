'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./core.js');

function row(options = {}) {
  const x = { id: '7d414f84a8', model: 'RTX PRO 6000', vram: 96, free: 1, total: 9,
    expandable: '1,617', cuda: '13.0', price: '6.98', ...options };
  return [x.id, 'A11机', `${x.model}\n${x.vram}GB`, `${x.free} / ${x.total}`,
    'CPU：22核\n内存：110GB', 'Xeon(R) Platinum', `数据盘：50GB\n可扩容：${x.expandable}GB`,
    `驱动：580.95.05 CUDA：${x.cuda}`, `￥${x.price}/时\n￥7.35/时`];
}
function host(options = {}, selectable = true) { return core.parseHost(row(options), selectable); }

test('reads the source from the current clone URL without restricting its region', () => {
  const current = 'example-source-87654321';
  assert.equal(core.cloneSourceId('https://www.autodl.com/cloneInstance?region=bj-B1&id=' + current), current);
  assert.equal(core.cloneSourceId('https://www.autodl.com/cloneInstance?id=' + current), current);
  assert.equal(core.cloneSourceId('https://www.autodl.com/cloneInstance?id=demo-source-12345678'), 'demo-source-12345678');
});

test('rejects missing, ambiguous or invalid source IDs and non-clone URLs', () => {
  for (const url of [
    'https://www.autodl.com/cloneInstance',
    'https://www.autodl.com/cloneInstance?id=',
    'https://www.autodl.com/cloneInstance?id=source-one&id=source-two',
    'https://www.autodl.com/cloneInstance?id=bad%20source',
    'https://www.autodl.com/console?id=source-one',
    'https://example.com/cloneInstance?id=source-one',
    'http://www.autodl.com/cloneInstance?id=source-one',
  ]) assert.throws(() => core.cloneSourceId(url));
});

test('accepts actual page-style 96GB host with 300GB expansion and price under 7', () => {
  const h = host();
  assert.equal(h.expandableGB, 1617);
  assert.equal(h.hourlyCny, 6.98);
  assert.equal(core.qualifies(h), true);
});
test('48GB and 300GB and 7 yuan are inclusive boundaries', () => {
  assert.equal(core.qualifies(host({model:'vGPU-48GB',vram:48,expandable:'300',price:'7.00'})), true);
  assert.equal(core.qualifies(host({vram:47,expandable:'300'})), false);
  assert.equal(core.qualifies(host({vram:48,expandable:'299'})), false);
  assert.equal(core.qualifies(host({price:'7.01'})), false);
});
test('checks GPU cell, not unrelated CPU memory or disk size', () => {
  assert.equal(core.qualifies(host({model:'RTX 5090',vram:32,expandable:'9000'})), false);
});
test('requires actually free, enabled GPU and CUDA 12.8+', () => {
  assert.equal(core.qualifies(host({free:0})), false);
  assert.equal(core.qualifies(host({}, false)), false);
  assert.equal(core.qualifies(host({cuda:'12.7'})), false);
  assert.equal(core.qualifies(host({cuda:'12.8'})), true);
  assert.equal(core.qualifies(host({cuda:'13.2'})), true);
});
test('unknown and placeholder metrics fail closed', () => {
  assert.equal(core.parseHost(row({cuda:'99'}), true), null);
  assert.equal(core.parseHost(row({expandable:'--'}), true), null);
  assert.equal(core.parseHost(row({price:'--'}), true), null);
  assert.equal(core.parseHost(row({free:10,total:9}), true), null);
  assert.equal(core.parseHost(['too few'], true), null);
});
test('only the current first displayed hourly rate determines the cap', () => {
  assert.equal(core.qualifies(host({price:'6.98'})), true);
  const cells = row({price:'7.01'}); cells[8] = '￥7.01/时\n￥6.50/时';
  assert.equal(core.qualifies(core.parseHost(cells, true)), false);
});
test('model counts handle any model name, and reject malformed counts', () => {
  assert.deepEqual(core.parseModelChoice('RTX 3090 (2/210)'), {name:'RTX 3090',free:2,total:210});
  assert.deepEqual(core.parseModelChoice('A800-80GB-NVLink （ 1 / 296 ）'), {name:'A800-80GB-NVLink',free:1,total:296});
  assert.equal(core.parseModelChoice('RTX (8/3)'), null);
  assert.equal(core.parseModelChoice('RTX 48GB'), null);
  assert.equal(core.parseModelChoice('全部'), null);
  assert.equal(core.parseModelChoice('(1/20)'), null);
  assert.equal(core.parseModelChoice('RTX (1/9007199254740992)'), null);
});

test('screenshot inventory selects only the stocked A800 before inspecting hosts', () => {
  const labels = ['vGPU-32GB (0/384)', 'RTX 5090 (0/2520)', 'RTX PRO 6000 (0/350)',
    'A800-80GB-NVLink (1/296)', 'vGPU-48GB (0/250)', 'vGPU-48GB-425W (0/170)',
    'RTX 5090 D (0/10)', 'RTX 4090D (0/184)', 'RTX 4090 (0/1352)', 'RTX 2080 Ti (0/88)', 'CPU (0/48)'];
  const choices = labels.map(core.parseModelChoice);
  assert.deepEqual(core.stockedModelChoices(choices).map(choice => choice.name), ['A800-80GB-NVLink']);
});

test('stock counters are gated before model selection and respect vram and disabled choices', () => {
  const choices = [
    core.parseModelChoice('RTX PRO 6000 (0/350)'), core.parseModelChoice('vGPU-32GB (1/384)'),
    core.parseModelChoice('CPU (2/48)'), core.parseModelChoice('A800-80GB-NVLink (1/296)'),
    {...core.parseModelChoice('vGPU-48GB (1/250)'), disabled:true},
  ];
  assert.deepEqual(core.stockedModelChoices(choices).map(choice => choice.name), ['A800-80GB-NVLink']);
  assert.deepEqual(core.stockedModelChoices(choices, {...core.LIMITS, minVramGB:96}), []);
  assert.deepEqual(core.stockedModelChoices([core.parseModelChoice('RTX 5090 (0/2520)')]), []);
});
test('skips known low-memory models before inspecting any hosts', () => {
  assert.equal(core.modelMayMeetVram('vGPU-32GB'), false);
  assert.equal(core.modelMayMeetVram('CPU-close-HT'), false);
  assert.equal(core.modelMayMeetVram('vGPU-48GB-350W'), true);
  for (const name of ['RTX 2080 Ti','RTX 3090','RTX 4090','RTX 4090D','RTX 5090','RTX 5090 D','RTX 5090 D v2','NVIDIA GeForce RTX 4070 Ti']) {
    assert.equal(core.modelMayMeetVram(name), false, name);
  }
  assert.equal(core.modelMayMeetVram('RTX A6000'), true);
  assert.equal(core.modelMayMeetVram('L40S'), true);
  assert.equal(core.modelMayMeetVram('RTX 6000D'), true);
  assert.equal(core.modelMayMeetVram('CustomRegionalGPU'), true);
});

test('model prefilter follows the configured threshold, including the screenshot 32GB boundary', () => {
  const settings = {...core.LIMITS, minVramGB:32};
  assert.equal(core.modelMayMeetVram('RTX 4090D', settings), false);
  assert.equal(core.modelMayMeetVram('RTX 3090', settings), false);
  assert.equal(core.modelMayMeetVram('RTX 5090', settings), true);
  assert.equal(core.modelMayMeetVram('RTX 5090 D v2', settings), false);
  assert.equal(core.modelMayMeetVram('RTX A6000', {...settings, minVramGB:49}), false);
  assert.equal(core.modelMayMeetVram('RTX PRO 6000', {...settings, minVramGB:96}), true);
  assert.equal(core.modelMayMeetVram('RTX PRO 6000', {...settings, minVramGB:97}), false);
});

test('explicit memory variants override standard memory and unknown models remain dynamic', () => {
  for (const name of ['RTX 3090-48GB', 'RTX 4090 D 48G', 'RTX4090D-48GiB', 'ＲＴＸ ４０９０ Ｄ ４８ＧＢ']) {
    assert.equal(core.modelMayMeetVram(name), true, name);
  }
  assert.equal(core.modelMayMeetVram('RTX PRO 6000-24GB'), false);
  assert.equal(core.modelMayMeetVram('RegionalCustomGPU'), true);
});

test('model matching tolerates spaces, letter case and full-width text without merging distinct models', () => {
  assert.equal(core.modelKey('RTX 4090 D'), core.modelKey('rtx4090d'));
  assert.equal(core.modelKey('ＲＴＸ ４０９０ Ｄ'), core.modelKey('RTX4090D'));
  assert.notEqual(core.modelKey('RTX 4090 D'), core.modelKey('RTX 4090'));
  assert.notEqual(core.modelKey('A800-80GB'), core.modelKey('A800-40GB'));
});
test('custom settings are validated and remain immutable', () => {
  const settings = core.validateSettings({...core.LIMITS, minVramGB:80, minExpandableGB:150,
    expandGB:0, maxHourlyCny:6.5, refreshSeconds:9, minCudaMajor:12, minCudaMinor:8});
  assert.ok(Object.isFrozen(settings));
  assert.equal(settings.expandGB, 0);
  for (const invalid of [
    {...core.LIMITS, minVramGB:0}, {...core.LIMITS, expandGB:-1},
    {...core.LIMITS, maxHourlyCny:0}, {...core.LIMITS, maxHourlyCny:Infinity},
    {...core.LIMITS, refreshSeconds:0}, {...core.LIMITS, refreshSeconds:1.5},
    {...core.LIMITS, requestedGPUs:2}, {...core.LIMITS, minCudaMajor:'12'},
  ]) assert.throws(() => core.validateSettings(invalid));
});
test('only explicit stock rejection can be retried automatically', () => {
  assert.equal(core.definiteStockFailure('GPU库存不足，请更换主机'), true);
  assert.equal(core.definiteStockFailure('当前主机GPU数量不足'), true);
  assert.equal(core.definiteStockFailure('创建失败，请稍后重试'), false);
  assert.equal(core.definiteStockFailure('网络超时'), false);
  assert.equal(core.definiteStockFailure('创建成功'), false);
  assert.equal(core.definiteStockFailure('GPU库存发生变更，请刷新后重新选择'), true);
  assert.equal(core.definiteStockFailure('错误\nGPU库存发生变更，请刷新后重新选择'), true);
  assert.equal(core.definiteStockFailure('错误：GPU库存发生变更，请刷新后重新选择。'), true);
  assert.equal(core.definiteStockFailure('GPU库存发生变更，请刷新后重新选择；订单结果未知'), false);
  assert.equal(core.definiteStockFailure('GPU库存发生变更，请刷新后重新选择\n创建成功'), false);
  assert.equal(core.definiteStockFailure('GPU库存发生变更'), false);
});

function harness(replacement = {}) {
  const events = [];
  let stored = null;
  const ledger = { getPending: () => stored, markPending: x => { stored=x; events.push('mark'); } };
  const adapter = {
    selectHost: async () => events.push('select'),
    setExpansion: async n => events.push(`disk:${n}`),
    readHost: async () => host(),
    verifyForm: async () => events.push('verify'),
    submit: () => events.push('click'),
    ...replacement,
  };
  return { events, ledger, adapter, getPending: () => stored };
}

test('sets disk and verifies fresh state before one durable submit', async () => {
  const h = harness();
  await core.submitOne(host(), h.adapter, h.ledger);
  assert.deepEqual(h.events, ['select','disk:300','verify','mark','click']);
  assert.equal(h.getPending().hostId, '7d414f84a8');
});

test('check-only prepares and verifies the real form without marking or submitting', async () => {
  const h = harness();
  const current = await core.prepareOne(host(), h.adapter);
  assert.equal(current.id, '7d414f84a8');
  assert.deepEqual(h.events, ['select','disk:300','verify']);
  assert.equal(h.getPending(), null);
});
test('custom settings drive eligibility and the actual requested disk expansion', async () => {
  const h = harness();
  const settings = {...core.LIMITS, minVramGB:80, minExpandableGB:100,
    expandGB:150, maxHourlyCny:7, refreshSeconds:9};
  await core.submitOne(host(), h.adapter, h.ledger, settings);
  assert.ok(h.events.includes('disk:150'));
  assert.equal(h.getPending().expandGB, 150);
  assert.equal(core.qualifies(host(), {...settings, maxHourlyCny:6}), false);
});
test('changed price or lost stock prevents creation and leaves no marker', async () => {
  for (const changed of [host({price:'7.01'}), host({free:0}), null]) {
    const h = harness({readHost: async () => changed});
    await assert.rejects(core.submitOne(host(), h.adapter, h.ledger));
    assert.equal(h.getPending(), null);
    assert.equal(h.events.includes('click'), false);
  }
});
test('existing uncertain submission prevents another click', async () => {
  const h = harness();
  h.ledger.markPending({hostId:'previous'});
  await assert.rejects(core.submitOne(host(), h.adapter, h.ledger), /未核实/);
  assert.equal(h.events.includes('click'), false);
});
test('exception during click leaves pending marker for manual reconciliation', async () => {
  const h = harness({submit: () => {throw new Error('browser interrupted');}});
  await assert.rejects(core.submitOne(host(), h.adapter, h.ledger), /interrupted/);
  assert.equal(h.getPending().hostId, '7d414f84a8');
});
test('failure to persist the submit marker prevents a paid click', async () => {
  const h = harness();
  h.ledger.getPending = async () => null;
  h.ledger.markPending = async () => { throw new Error('extension storage unavailable'); };
  await assert.rejects(core.submitOne(host(), h.adapter, h.ledger), /storage unavailable/);
  assert.equal(h.events.includes('click'), false);
});
test('form verification failure or disk-setting failure never submits', async () => {
  for (const adapter of [{verifyForm: async () => {throw new Error('changed form');}},
                         {setExpansion: async () => {throw new Error('bad disk');}}]) {
    const h = harness(adapter);
    await assert.rejects(core.submitOne(host(), h.adapter, h.ledger));
    assert.equal(h.getPending(), null);
    assert.equal(h.events.includes('click'), false);
  }
});
