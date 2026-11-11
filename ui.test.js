'use strict';

// Browser integration test with an intercepted, entirely synthetic AutoDL page.
// It does not connect to AutoDL or use the user's browser profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const IMAGE_SELECTOR = '#mock-image .el-cascader input';

async function injectExtension(page) {
  await page.addScriptTag({path:path.join(__dirname,'core.js')});
  await page.addScriptTag({path:path.join(__dirname,'content.js')});
}

const createImageFixture = `
if (location.pathname === '/create') {
  document.querySelector('.noMachine').remove();
  const region = document.querySelector('[data-test-region]');
  const other = document.createElement('label');
  other.className = 'el-radio-button'; other.setAttribute('aria-checked', 'false');
  other.innerHTML = '<input type="radio" name="region" value="test-other-region">另一个测试地区';
  region.after(other);
  for (const label of [region, other]) label.addEventListener('click', () => {
    for (const item of [region, other]) { item.setAttribute('aria-checked', String(item === label)); item.querySelector('input').checked = item === label; }
  });
  const mirror = document.createElement('section'); mirror.id = 'mock-image';
  mirror.innerHTML = '<label class="el-radio-button" aria-checked="true"><input type="radio" name="image-type" value="basicImage" checked>基础镜像</label>' +
    '<label class="el-radio-button" aria-checked="false"><input type="radio" name="image-type" value="customImage">我的镜像</label>' +
    '<label class="el-radio-button" aria-checked="false"><input type="radio" name="image-type" value="CodeWithGPU">社区镜像</label>' +
    '<div class="el-cascader"><input readonly placeholder="请选择框架名称/框架版本/Python版本/CUDA版本"></div>';
  document.body.append(mirror);
  for (const label of mirror.querySelectorAll('label')) label.addEventListener('click', () => {
    for (const item of mirror.querySelectorAll('label')) item.setAttribute('aria-checked', String(item === label));
  });
  const image = mirror.querySelector('.el-cascader input');
  const choices = [['PyTorch','Miniconda'],['2.8.0','2.5.1'],['3.12(ubuntu22.04)'],['12.8','13.0','14.0']];
  const path = choices.map(items => items[0]);
  image.value = path.join(' / ');
  const drop = document.createElement('div'); drop.className = 'el-cascader-panel'; drop.hidden = true;
  document.body.append(drop);
  const selected = [];
  function renderMenus(depth) {
    while (drop.children.length > depth) drop.lastChild.remove();
    const menu = document.createElement('div'); menu.className = 'el-cascader-menu';
    const list = document.createElement('ul'); menu.append(list); drop.append(menu);
    for (const text of choices[depth]) {
      const node = document.createElement('li'); node.className = 'el-cascader-node';
      node.setAttribute('role','menuitem');
      const label = document.createElement('span'); label.className = 'el-cascader-node__label';
      const span = document.createElement('span'); span.dataset.title = '标题'; span.textContent = text;
      label.append(span); node.append(label); list.append(node);
      node.addEventListener('click', () => {
        selected[depth] = text;
        window.__imageClicks = (window.__imageClicks || 0) + 1;
        if (depth < 3) renderMenus(depth + 1);
        else { image.value = selected.join(' / '); drop.hidden = true; }
      });
    }
  }
  image.addEventListener('click', () => { drop.hidden = false; renderMenus(0); });
}
`;

const fakePage = `<!doctype html><html><head><style>
.el-table__body-wrapper { height:120px; overflow:auto; }
tr { height:35px; } .el-message { position:fixed; top:5px; left:5px; background:#fff; }
</style></head><body>
<div class="noMachine">以实例：demo-source-12345678的系统创建新实例</div>
<label class="el-radio-button" aria-checked="true"><input type="radio" value="payg">按量计费</label>
<label data-test-region class="el-radio-button" aria-checked="true"><input type="radio" value="westDC3">西北B区</label>
<label class="el-radio-button" aria-checked="true"><input type="radio" value="1">1</label>
<label class="el-checkbox"><input type="checkbox" value="RTX 6000D">RTX 6000D (1/20)</label>
<label class="el-checkbox"><input type="checkbox" value="需要扩容" checked>需要扩容</label>
<div class="el-table__body-wrapper"><table class="el-table__body"><tbody></tbody></table></div>
<input class="el-input__inner" type="text" role="spinbutton" min="0" max="0" value="0">
<button id="create" type="button" disabled>创建并开机</button>
<script>
const tbody = document.querySelector('tbody');
const wrapper = document.querySelector('.el-table__body-wrapper');
const gpu = document.querySelector('input[value="RTX 6000D"]');
const spin = document.querySelector('input[role="spinbutton"]');
const create = document.querySelector('#create');
const mode = new URL(location.href).searchParams.get('test_mode');
const hostModel = new URL(location.href).searchParams.get('test_model') || 'RTX 6000D';
const hostVram = new URL(location.href).searchParams.get('test_vram') || '84';
const goodIndex = Number(new URL(location.href).searchParams.get('test_good_index') ?? 2);
const sourceId = new URL(location.href).searchParams.get('id');
document.querySelector('.noMachine').textContent = '以实例：' + sourceId + '的系统创建新实例';
if (mode === 'slow-page') {
  const source = document.querySelector('.noMachine');
  source.innerText = '';
  setTimeout(() => { source.innerText = '以实例：' + sourceId + '的系统创建新实例'; }, 6000);
}
${createImageFixture}
let count = 0, loading = false;
window.__submitted = 0;
function renderRow(i) {
  const good = i === goodIndex;
  const free = mode === 'no-stock' ? 0 : mode === 'zero-first' ? (good ? 1 : 0) :
    mode === 'unsorted' && i === 1 ? 0 : (i <= goodIndex ? 1 : 0);
  const freeText = mode === 'unreadable' && i === 1 ? '--' : free + ' / 8';
  const price = good && mode === 'expensive' ? '7.01' : '6.46';
  const expansion = good ? 600 : 100;
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><label class="el-radio"><input type="radio" name="host" value="'+(mode === 'no-stock' ? '0' : 'mockhost'+i)+'" '+(free?'':'disabled')+'>mockhost'+i+'</label></td>'+
    '<td>测试机'+i+'</td><td>'+hostModel+'<br>'+hostVram+'GB</td><td>'+freeText+'</td><td>CPU：22核<br>内存：110GB</td>'+
    '<td>Xeon</td><td>数据盘：50GB<br>可扩容：'+expansion+'GB</td><td>驱动：580 CUDA：13.0</td><td>￥'+price+'/时<br>￥6.80/时</td>';
  tr.querySelector('input').addEventListener('change', () => {
    spin.max = mode === 'disk-mismatch' ? '200' : '600'; create.disabled = false;
    if (mode === 'stock-change-select') showStockChange(true);
  });
  tbody.appendChild(tr);
}
function page() { for(let i = count; i < Math.min(count+10,20); i++) renderRow(i); count = Math.min(count+10,20); }
page();
gpu.addEventListener('change', () => {});
wrapper.addEventListener('scroll', () => {
  if (loading || count >= 20 || wrapper.scrollTop + wrapper.clientHeight < wrapper.scrollHeight - 2) return;
  loading = true;
  sessionStorage.setItem('mockScrollRequests', String(Number(sessionStorage.getItem('mockScrollRequests') || 0) + 1));
  // Real page briefly appends skeleton rows before populating them.
  for(let i=0;i<10;i++) { const tr=document.createElement('tr'); tr.className='skeleton'; tr.innerHTML='<td><input type="radio" value="0" disabled></td>'; tbody.appendChild(tr); }
  setTimeout(() => { document.querySelectorAll('.skeleton').forEach(e=>e.remove()); page(); loading=false; }, 250);
});
function showStockChange(dialog) {
  const message = document.createElement('div');
  if (dialog) {
    message.className = 'el-message-box__wrapper';
    message.innerHTML = '<div class="el-message-box__title">错误</div>' +
      '<div class="el-message-box__message">GPU库存发生变更，请刷新后重新选择</div>' +
      '<div class="el-message-box__btns"><button type="button">确定</button></div>';
  } else {
    message.className = 'el-message';
    message.textContent = '错误：GPU库存发生变更，请刷新后重新选择';
  }
  document.body.appendChild(message);
}
create.addEventListener('click', () => {
  const diskChecked = document.querySelector('input[value="需要扩容"]').checked;
  const expected = mode === 'custom' ? '150' : '300';
  if ((mode === 'zero-disk' ? diskChecked : spin.value !== expected || !diskChecked) ||
      !document.querySelector('input[name="host"]:checked')) throw new Error('form wrong');
  window.__submitted++;
  sessionStorage.setItem('mockTotalSubmitted', String(Number(sessionStorage.getItem('mockTotalSubmitted') || 0) + 1));
  if (['stock-change','stock-change-dialog','stock-change-success'].includes(mode)) {
    showStockChange(mode === 'stock-change-dialog');
    if (mode === 'stock-change-success') {
      const success = document.createElement('div'); success.className = 'el-message'; success.textContent = '创建成功'; document.body.appendChild(success);
    }
    return;
  }
  if (['success','slow-page','nostock','custom','zero-disk','zero-first','unsorted','unreadable'].includes(mode)) {
    const message=document.createElement('div'); message.className='el-message';
    message.textContent=mode === 'nostock' ? 'GPU库存不足，请更换主机' : '创建成功';
    document.body.appendChild(message);
  }
});
</script></body></html>`;

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined),
    args: ['--disable-background-networking'] });
});
test.after(async () => { if (browser) await browser.close(); });

async function start(mode, existingContext, values = {}, options = {}) {
  const context = existingContext || await browser.newContext();
  if (!existingContext) {
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin === 'https://www.autodl.com' && ['/cloneInstance','/create'].includes(u.pathname))
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fakePage });
      return route.abort();
    });
    await context.addInitScript(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => original(fn, Math.max(1, Math.round((ms || 0) * .05)), ...args);
      window.confirm = message => { window.__lastConfirm = message; return true; };
      // Fake the extension's private storage without contacting AutoDL.
      const prefix = '__test_extension_storage__';
      const local = {
        async get(keys) {
          const result = {};
          for (const key of (Array.isArray(keys) ? keys : [keys])) {
            const value = localStorage.getItem(prefix + key);
            if (value !== null) result[key] = JSON.parse(value);
          }
          return result;
        },
        async set(items) { for (const [k, v] of Object.entries(items)) localStorage.setItem(prefix + k, JSON.stringify(v)); },
        async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) localStorage.removeItem(prefix + k); },
      };
      if (!window.chrome) window.chrome = {};
      Object.defineProperty(window.chrome, 'storage', {value:{local}, configurable:true});
    });
  }
  const page = await context.newPage();
  const copy = mode === 'copy-on' ? '1' : '';
  const url = new URL('https://www.autodl.com/' + (options.create ? 'create' : 'cloneInstance'));
  if (options.urlRegion !== null) url.searchParams.set('region', options.urlRegion ?? 'west-E');
  if (!options.create && options.sourceId !== null) url.searchParams.set('id', options.sourceId ?? 'demo-source-12345678');
  url.searchParams.set('copy_data_disk', copy);
  url.searchParams.set('test_mode', mode);
  if (options.hostModel) url.searchParams.set('test_model', options.hostModel);
  if (options.hostVram) url.searchParams.set('test_vram', String(options.hostVram));
  if (options.goodIndex !== undefined) url.searchParams.set('test_good_index', String(options.goodIndex));
  await page.goto(url.href);
  if (options.imagePath !== undefined) await page.locator('#mock-image .el-cascader input').evaluate((input, value) => { input.value = value; }, options.imagePath);
  if (options.imageType) await page.locator('#mock-image input[value="' + options.imageType + '"]').click();
  if (options.inventory) await page.evaluate(inventory => {
    const old = document.querySelector('input[value="RTX 6000D"]').closest('label');
    const group = document.createElement('div');
    group.id = 'mock-model-inventory';
    window.__modelClicks = [];
    for (const [index, item] of [{label:'全部'}, ...inventory].entries()) {
      const label = document.createElement('label');
      label.className = 'el-checkbox';
      label.hidden = item.hidden === true;
      const input = document.createElement('input');
      input.type = 'checkbox';
      // Values deliberately differ from the displayed GPU model names.
      input.value = 'opaque-model-' + index;
      input.disabled = item.disabled === true;
      label.append(input, document.createTextNode(item.label));
      label.addEventListener('change', () => {
        if (input.checked) window.__modelClicks.push(label.textContent);
      });
      group.append(label);
    }
    old.replaceWith(group);
  }, options.inventory);
  if (options.pageSourceId) await page.locator('.noMachine').evaluate((node, id) => {
    node.textContent = '以实例：' + id + '的系统创建新实例';
  }, options.pageSourceId);
  if (Object.hasOwn(options, 'pageRegion')) {
    await page.locator('[data-test-region]').evaluate((label, region) => {
      if (region === null) return label.remove();
      label.querySelector('input').value = region;
      label.lastChild.textContent = '页面自动确定的区域';
    }, options.pageRegion);
  }
  await page.evaluate(() => {
    window.__regionClicks = 0;
    document.querySelector('[data-test-region]')?.addEventListener('click', () => window.__regionClicks++);
  });
  if (options.legacyPending) {
    await page.evaluate(() => localStorage.setItem('autodl_clone_grab_pending_demo-source-12345678', '{"hostId":"old-attempt"}'));
  }
  await page.addScriptTag({path:path.join(__dirname,'core.js')});
  await page.addScriptTag({path:path.join(__dirname,'content.js')});
  await page.locator('[data-action="start"]').waitFor({state:'visible'});
  await page.waitForFunction(() => !document.querySelector('[data-action="start"]').disabled);
  for (const [name, value] of Object.entries(values)) await page.locator('[data-setting="'+name+'"]').fill(String(value));
  if (options.autoStart !== false) await page.locator('[data-action="' + (options.checkOnly ? 'check' : 'start') + '"]').click();
  return {context, page};
}

async function installDynamicModelFixture(page) {
  await page.evaluate(() => {
    window.__showAvailableHost = model => {
      const rows = [...document.querySelectorAll('tbody tr')];
      for (const [index, row] of rows.entries()) {
        row.cells[2].replaceChildren(document.createTextNode(model), document.createElement('br'), document.createTextNode('96GB'));
        row.cells[3].textContent = index === 0 ? '1 / 8' : '0 / 8';
        row.cells[6].textContent = '数据盘：50GB 可扩容：600GB';
        const input = row.querySelector('input');
        input.checked = false;
        input.disabled = index !== 0;
        input.value = index === 0 ? 'mockhost0' : '0';
      }
      document.querySelector('#create').disabled = true;
    };
    window.__replaceInventory = items => {
      const group = document.querySelector('#mock-model-inventory');
      group.replaceChildren();
      for (const item of items) {
        const label = document.createElement('label');
        label.className = 'el-checkbox';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = crypto.randomUUID();
        label.append(input, document.createTextNode(item.name + ' (' + item.free + '/20)'));
        input.addEventListener('change', () => {
          if (!input.checked) return;
          window.__modelClicks.push(label.textContent);
          if (item.hasHost) window.__showAvailableHost(item.name);
        });
        group.append(label);
      }
    };
  });
}

test('adapts to unrelated regional model lists and ignores hidden models from another region', async t => {
  for (const [region, labelModel, hostModel] of [
    ['region-east', 'Regional GPU Alpha', 'Regional GPU Alpha'],
    ['region-west', 'Custom-Zeta-96GB', 'Custom-Zeta-96GB'],
    ['region-south', 'Regional GPU Omega', 'regionalgpuomega'],
  ]) {
    await t.test(region, async () => {
      const {context,page} = await start('success', undefined, {}, {
        urlRegion:region, pageRegion:region, hostModel, hostVram:96,
        inventory:[{label:'HiddenOldRegionGPU (1/20)', hidden:true}, {label:labelModel + ' (1/20)'}, {label:'OtherGPU (0/20)'}],
      });
      try {
        await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
        assert.deepEqual(await page.evaluate(() => window.__modelClicks), [labelModel + ' (1/20)']);
        assert.equal(await page.evaluate(() => window.__submitted), 1);
        assert.equal(await page.evaluate(() => window.__regionClicks), 0);
      } finally { await context.close(); }
    });
  }
});

test('discovers a model restocked during the round instead of using the initial stocked list', async () => {
  const {context,page} = await start('no-stock', undefined, {}, {
    inventory:[{label:'FirstRegionGPU (1/20)'}, {label:'LaterRegionGPU (0/20)'}],
    hostModel:'FirstRegionGPU', autoStart:false,
  });
  try {
    await installDynamicModelFixture(page);
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('#mock-model-inventory label')];
      const first = labels.find(label => label.textContent.startsWith('FirstRegionGPU'));
      const later = labels.find(label => label.textContent.startsWith('LaterRegionGPU'));
      first.addEventListener('change', () => {
        if (first.querySelector('input').checked) later.lastChild.textContent = 'LaterRegionGPU (1/20)';
      });
      later.addEventListener('change', () => {
        if (later.querySelector('input').checked) window.__showAvailableHost('LaterRegionGPU');
      });
    });
    await page.locator('[data-action="check"]').click();
    await page.locator('[data-status]').getByText(/仅检查完成：LaterRegionGPU.*检查通过/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), ['FirstRegionGPU (1/20)', 'LaterRegionGPU (1/20)']);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('rereads a replaced model list or changed region and checks the new available model', async t => {
  for (const changeRegion of [false, true]) {
    await t.test(changeRegion ? 'region changed' : 'model list changed', async () => {
      const {context,page} = await start('no-stock', undefined, {}, {
        inventory:[{label:'OldRegionGPU (1/20)'}], hostModel:'OldRegionGPU', autoStart:false,
      });
      try {
        await installDynamicModelFixture(page);
        await page.evaluate(changeRegion => {
          const old = [...document.querySelectorAll('#mock-model-inventory label')].find(label => label.textContent.startsWith('OldRegionGPU'));
          old.addEventListener('change', () => {
            if (!old.querySelector('input').checked) return;
            if (changeRegion) {
              const url = new URL(location.href);
              url.searchParams.set('region', 'new-region');
              history.replaceState(null, '', url);
              document.querySelector('[data-test-region] input').value = 'newDC';
            }
            window.__replaceInventory([{name:'NewRegionalGPU', free:1, hasHost:true}]);
          });
        }, changeRegion);
        await page.locator('[data-action="check"]').click();
        await page.locator('[data-status]').getByText(/仅检查完成：NewRegionalGPU.*检查通过/).waitFor({timeout:12000});
        assert.deepEqual(await page.evaluate(() => window.__modelClicks), ['OldRegionGPU (1/20)', 'NewRegionalGPU (1/20)']);
        assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost0');
        assert.equal(await page.evaluate(() => window.__submitted), 0);
      } finally { await context.close(); }
    });
  }
});

test('drops a selected host when its region changes before form verification', async () => {
  const {context,page} = await start('success', undefined, {}, {
    inventory:[{label:'OldRegionGPU (1/20)'}], hostModel:'OldRegionGPU', autoStart:false,
  });
  try {
    await installDynamicModelFixture(page);
    await page.evaluate(() => {
      document.querySelector('tbody').addEventListener('change', event => {
        if (event.target.name !== 'host') return;
        const url = new URL(location.href);
        url.searchParams.set('region', 'new-region');
        history.replaceState(null, '', url);
        window.__replaceInventory([{name:'NewRegionGPU', free:0}]);
      });
    });
    await page.locator('[data-action="check"]').click();
    await page.locator('[data-status]').getByText(/型号栏空闲库存为 0/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
    assert.equal(await page.locator('input[role="spinbutton"]').inputValue(), '0');
  } finally { await context.close(); }
});

test('a view change after recording a pending order retains the marker and never restarts creation', async () => {
  const {context,page} = await start('success', undefined, {}, {autoStart:false});
  try {
    await page.evaluate(() => {
      const original = chrome.storage.local.set;
      chrome.storage.local.set = async items => {
        await original(items);
        if (!Object.keys(items).some(key => key.startsWith('autodl_clone_grab_pending_'))) return;
        const url = new URL(location.href);
        url.searchParams.set('region', 'changed-at-submit');
        history.replaceState(null, '', url);
      };
    });
    await page.locator('[data-action="start"]').click();
    await page.locator('[data-status]').getByText(/提交状态待核实：地区或显卡列表已变化/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.ok(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')));
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), null);
  } finally { await context.close(); }
});

const screenshotInventory = [
  'vGPU-32GB (0/384)', 'RTX 5090 (0/2520)', 'RTX PRO 6000 (0/350)',
  'A800-80GB-NVLink (1/296)', 'vGPU-48GB (0/250)', 'vGPU-48GB-425W (0/170)',
  'RTX 5090 D (0/10)', 'RTX 4090D (0/184)', 'RTX 4090 (0/1352)', 'RTX 2080 Ti (0/88)', 'CPU (0/48)',
].map(label => ({label}));

test('screenshot model counters select only the stocked A800 even with opaque checkbox values', async () => {
  const {context,page} = await start('success', undefined, {}, {
    inventory:screenshotInventory, hostModel:'A800-80GB-NVLink', hostVram:80,
  });
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), ['A800-80GB-NVLink (1/296)']);
    assert.equal(await page.locator('#mock-model-inventory input:checked').count(), 1);
    assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost2');
    assert.equal(await page.evaluate(() => window.__submitted), 1);
  } finally { await context.close(); }
});

test('zero model counters skip selection and host scanning, regardless of the existing table', async () => {
  const inventory = screenshotInventory.map(item => ({label:item.label.replace('(1/296)', '(0/296)')}));
  const {context,page} = await start('success', undefined, {}, {inventory, checkOnly:true});
  try {
    await page.locator('[data-status]').getByText(/型号栏空闲库存为 0/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), []);
    assert.equal(await page.locator('input[name="host"]:checked').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('stocked models below the memory requirement are not selected or scanned', async () => {
  const inventory = ['vGPU-32GB (1/384)','RTX 2080 Ti (1/88)','RTX 3090 (2/200)',
    'RTX 4090D (1/184)','RTX 5090 (1/2520)','RTX 5090 D (1/10)','A800-80GB-NVLink (0/296)'].map(label => ({label}));
  const {context,page} = await start('success', undefined, {}, {inventory, checkOnly:true});
  try {
    await page.locator('[data-status]').getByText(/有库存，但暂无可选且符合显存要求的型号/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), []);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('never selects stocked low-memory models when an eligible model is available', async () => {
  const inventory = ['RTX 2080 Ti (1/88)','RTX 3090 (2/200)','RTX 4090D (1/184)',
    'RTX 5090 (1/2520)','A800-80GB-NVLink (1/296)'].map(label => ({label}));
  const {context,page} = await start('success', undefined, {}, {inventory, hostModel:'A800-80GB-NVLink', hostVram:80});
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), ['A800-80GB-NVLink (1/296)']);
    assert.equal(await page.evaluate(() => window.__submitted), 1);
  } finally { await context.close(); }
});

test('a qualified explicit memory variant is still checked instead of being excluded by its standard model', async () => {
  const inventory = [{label:'RTX 4090 D (1/184)'}, {label:'RTX 4090 D-48GB (1/20)'}];
  const {context,page} = await start('success', undefined, {}, {inventory, hostModel:'RTX 4090 D-48GB', hostVram:48});
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), ['RTX 4090 D-48GB (1/20)']);
    assert.equal(await page.evaluate(() => window.__submitted), 1);
  } finally { await context.close(); }
});

test('rechecks the model counter after clearing All and skips stock that just disappeared', async () => {
  const {context,page} = await start('success', undefined, {}, {
    inventory:screenshotInventory, hostModel:'A800-80GB-NVLink', hostVram:80, autoStart:false,
  });
  try {
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('#mock-model-inventory label')];
      const all = labels.find(label => label.textContent === '全部');
      const target = labels.find(label => label.textContent.startsWith('A800-80GB-NVLink'));
      all.querySelector('input').checked = true;
      all.addEventListener('change', () => { target.lastChild.textContent = 'A800-80GB-NVLink (0/296)'; });
    });
    await page.locator('[data-action="check"]').click();
    await page.locator('[data-status]').getByText(/仅检查完成.*未找到符合条件/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), []);
    assert.equal(await page.locator('#mock-model-inventory input:checked').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('a qualifying top-three host is selected and submitted once with a 300GB expansion', async () => {
  const {context,page} = await start('success');
  try {
    assert.equal(await page.locator('[data-setting="refreshSeconds"]').inputValue(), '5');
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.equal(await page.locator('input[role="spinbutton"]').inputValue(), '300');
    assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost2');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
    assert.ok(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')));
  } finally { await context.close(); }
});

test('uses the clone page region without requiring or changing a fixed region', async t => {
  for (const options of [
    {urlRegion:'other-region', pageRegion:'otherDC'},
    {urlRegion:'west-E', pageRegion:'otherDC'},
    {urlRegion:null, pageRegion:'otherDC'},
    {urlRegion:null, pageRegion:null},
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const {context,page} = await start('success', undefined, {}, options);
      try {
        await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
        assert.equal(await page.evaluate(() => window.__submitted), 1);
        assert.equal(await page.evaluate(() => window.__regionClicks), 0);
        assert.match(await page.locator('#autodl-clone-grabber-panel').innerText(), /区域跟随克隆页面/);
        assert.equal(new URL(page.url()).searchParams.get('region'), options.urlRegion);
        if (options.pageRegion === null) assert.equal(await page.locator('[data-test-region]').count(), 0);
        else assert.equal(await page.locator('[data-test-region] input').inputValue(), options.pageRegion);
      } finally { await context.close(); }
    });
  }
});

test('a clone source from the URL works and gets its own submission marker', async () => {
  const sourceId = 'example-source-87654321';
  const {context,page} = await start('success', undefined, {}, {urlRegion:'bj-B1', sourceId});
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.equal(await page.locator('[data-source]').innerText(), '源实例：' + sourceId);
    assert.ok(await page.evaluate(id => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_' + id), sourceId));
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
    assert.match(await page.evaluate(() => window.__lastConfirm), new RegExp(sourceId));
  } finally { await context.close(); }
});

test('a page showing a different source than its URL is still refused', async () => {
  const {context,page} = await start('success', undefined, {}, {urlRegion:null, sourceId:'other-source', pageSourceId:'stale-source'});
  try {
    await page.locator('[data-status]').getByText(/页面加载超时/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
  } finally { await context.close(); }
});

test('a missing source ID gives a clear error without starting', async () => {
  const {context,page} = await start('success', undefined, {}, {sourceId:null});
  try {
    await page.locator('[data-status]').getByText(/缺少有效且唯一的源实例 ID/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_')), null);
  } finally { await context.close(); }
});

test('check-only validates the current source and form without creating or recording a pending order', async () => {
  const sourceId = 'example-source-87654321';
  const {context,page} = await start('success', undefined, {}, {urlRegion:'bj-B1', sourceId, checkOnly:true});
  try {
    await page.locator('[data-status]').getByText(/仅检查完成.*提交前检查通过，未创建实例/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.locator('input[role="spinbutton"]').inputValue(), '300');
    assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost2');
    assert.equal(await page.evaluate(id => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_' + id), sourceId), null);
    assert.equal(await page.evaluate(id => sessionStorage.getItem('autodl_clone_grab_run_' + id), sourceId), null);
    assert.equal(await page.evaluate(() => window.__lastConfirm), undefined);
    await page.waitForFunction(() => !document.querySelector('[data-action="start"]').disabled);
  } finally { await context.close(); }
});

test('check-only finishes once without reloading when no host qualifies', async () => {
  const {context,page} = await start('no-stock', undefined, {}, {checkOnly:true});
  try {
    await page.locator('[data-status]').getByText(/仅检查完成.*未找到符合条件.*不会自动刷新/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), null);
    assert.equal(await page.locator('#autodl-clone-grabber-panel').count(), 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
    assert.equal(await page.locator('tbody tr').count(), 10);
  } finally { await context.close(); }
});

test('reloading an interrupted check never resumes paid monitoring', async () => {
  const {context,page} = await start('success', undefined, {}, {autoStart:false});
  try {
    await page.evaluate(() => sessionStorage.setItem('autodl_clone_grab_run_demo-source-12345678', 'check'));
    await page.reload();
    await page.addScriptTag({path:path.join(__dirname,'core.js')});
    await page.addScriptTag({path:path.join(__dirname,'content.js')});
    await page.locator('[data-status]').getByText(/上次仅检查已中断/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), null);
    await page.waitForFunction(() => !document.querySelector('[data-action="start"]').disabled);
  } finally { await context.close(); }
});

test('a host over the hourly limit is never submitted', async () => {
  const {context,page} = await start('expensive');
  try {
    await page.waitForEvent('load', {timeout:12000});
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockTotalSubmitted')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
  } finally { await context.close(); }
});

test('an ambiguous submission stops with a persistent marker and no duplicate click', async () => {
  const {context,page} = await start('unknown');
  try {
    await page.locator('[data-status]').getByText(/提交结果尚不明确/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    await page.locator('[data-action="start"]').click();
    assert.match(await page.locator('[data-status]').innerText(), /未核实/);
    assert.equal(await page.evaluate(() => window.__submitted), 1);
  } finally { await context.close(); }
});

test('a definite inventory rejection clears the marker and refreshes for retry', async () => {
  const {context,page} = await start('nostock');
  try {
    await page.waitForEvent('load', {timeout:12000});
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockTotalSubmitted')), '1');
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), '1');
  } finally { await context.close(); }
});

test('the screenshot inventory-change rejection refreshes for retry in a toast or dialog with footer buttons', async t => {
  for (const mode of ['stock-change','stock-change-dialog']) {
    await t.test(mode, async () => {
      const {context,page} = await start(mode);
      try {
        await page.waitForEvent('load', {timeout:12000});
        assert.equal(await page.evaluate(() => sessionStorage.getItem('mockTotalSubmitted')), '1');
        assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), '1');
      } finally { await context.close(); }
    });
  }
});

test('inventory change reported while selecting a host refreshes without a paid click', async () => {
  const {context,page} = await start('stock-change-select');
  try {
    await page.waitForEvent('load', {timeout:12000});
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockTotalSubmitted')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), '1');
  } finally { await context.close(); }
});

test('a simultaneous success message prevents stock-change retry and keeps the submission marker', async () => {
  const {context,page} = await start('stock-change-success');
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.ok(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')));
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), null);
  } finally { await context.close(); }
});

test('a second tab cannot run the same task or create a duplicate', async () => {
  const first = await start('unknown');
  try {
    const second = await start('unknown', first.context);
    await second.page.locator('[data-status]').getByText(/另一个标签页|未核实/).waitFor({timeout:12000});
    const count1 = await first.page.evaluate(() => window.__submitted);
    const count2 = await second.page.evaluate(() => window.__submitted);
    assert.ok(count1 <= 1);
    assert.equal(count2, 0);
  } finally { await first.context.close(); }
});

test('disk input refusing 300GB prevents submission', async () => {
  const {context,page} = await start('disk-mismatch');
  try {
    await page.locator('[data-status]').getByText(/无法确认|未确认可扩容/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
  } finally { await context.close(); }
});

test('link with automatic data-disk copying enabled is refused', async () => {
  const {context,page} = await start('copy-on');
  try {
    await page.locator('[data-status]').getByText(/链接启用了数据盘复制/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('waits for the source information after a slow page reload', async () => {
  const {context,page} = await start('slow-page');
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
  } finally { await context.close(); }
});

test('custom thresholds, price, expansion and interval are confirmed and used', async () => {
  const values = {minVramGB:80, minExpandableGB:150, expandGB:150,
    maxHourlyCny:6.5, refreshSeconds:9, cudaVersion:'12.8'};
  const {context,page} = await start('custom', undefined, values);
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.equal(await page.locator('input[role="spinbutton"]').inputValue(), '150');
    const message = await page.evaluate(() => window.__lastConfirm);
    assert.match(message, /显存≥80GB/);
    assert.match(message, /实际扩容150GB/);
    assert.match(message, /≤6\.5元\/时/);
    assert.match(message, /9秒刷新/);
    const p = await page.evaluate(() => JSON.parse(localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')));
    assert.equal(p.expandGB, 150);
  } finally { await context.close(); }
});

test('zero expansion turns the disk checkbox off', async () => {
  const {context,page} = await start('zero-disk', undefined, {expandGB:0});
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.equal(await page.locator('input[value="需要扩容"]').isChecked(), false);
  } finally { await context.close(); }
});

test('checks the third host even when the first two hosts show zero stock', async () => {
  const {context,page} = await start('zero-first');
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost2');
  } finally { await context.close(); }
});

test('switches from All to the specific in-stock model before inspecting its hosts', async () => {
  const {context,page} = await start('zero-first', undefined, {}, {autoStart:false});
  try {
    await page.evaluate(() => {
      const gpu = document.querySelector('input[value="RTX 6000D"]');
      const all = document.createElement('label');
      all.className = 'el-checkbox';
      all.innerHTML = '<input type="checkbox" value="all" checked>全部';
      const other = document.createElement('label');
      other.className = 'el-checkbox';
      other.innerHTML = '<input type="checkbox" value="RTX 3090" checked>RTX 3090 (0/20)';
      gpu.closest('label').before(all, other);
      gpu.checked = true;
      window.__specificSelected = false;
      const updateFilter = () => {
        if (all.querySelector('input').checked || other.querySelector('input').checked || !gpu.checked) return;
        window.__specificSelected = true;
        const row = document.querySelector('tbody tr');
        row.cells[3].textContent = '1 / 8';
        row.cells[6].textContent = '数据盘：50GB 可扩容：600GB';
        row.querySelector('input').disabled = false;
      };
      all.addEventListener('change', updateFilter);
      other.addEventListener('change', updateFilter);
      gpu.addEventListener('change', updateFilter);
    });
    await page.locator('[data-action="start"]').click();
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__specificSelected), true);
    assert.equal(await page.locator('input[value="all"]').isChecked(), false);
    assert.equal(await page.locator('input[value="RTX 3090"]').isChecked(), false);
    assert.equal(await page.locator('input[value="RTX 6000D"]').isChecked(), true);
    assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost0');
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
  } finally { await context.close(); }
});

test('checks the remaining top-three hosts after zero or unreadable inventory rows', async t => {
  for (const mode of ['unsorted','unreadable']) {
    await t.test(mode, async () => {
      const {context,page} = await start(mode);
      try {
        await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
        assert.equal(await page.evaluate(() => window.__submitted), 1);
        assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost2');
        assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
      } finally { await context.close(); }
    });
  }
});

test('invalid top-three rows never cause the fourth host to be included', async () => {
  const {context,page} = await start('unsorted', undefined, {}, {autoStart:false, goodIndex:3});
  try {
    await page.locator('tbody tr').nth(0).locator('td').nth(7).evaluate(cell => { cell.textContent = '--'; });
    await page.locator('[data-action="check"]').click();
    await page.locator('[data-status]').getByText(/仅检查完成.*未找到符合条件/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.locator('input[name="host"]:checked').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
  } finally { await context.close(); }
});

test('takes an eligible host at any of the first three positions without loading more hosts', async t => {
  for (const goodIndex of [0,1,2]) {
    await t.test('position ' + (goodIndex + 1), async () => {
      const {context,page} = await start('success', undefined, {}, {goodIndex});
      try {
        await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
        assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost' + goodIndex);
        assert.equal(await page.evaluate(() => window.__submitted), 1);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
      } finally { await context.close(); }
    });
  }
});

test('never reads or selects hosts below the top-three boundary and never loads a later batch', async t => {
  for (const goodIndex of [3,8,15]) {
    await t.test('eligible host outside top three: ' + (goodIndex + 1), async () => {
      const {context,page} = await start('success', undefined, {}, {goodIndex, autoStart:false});
      try {
        await page.evaluate(() => {
          window.__laterRowReads = 0;
          const getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').get;
          for (const row of [...document.querySelectorAll('tbody tr')].slice(3)) {
            for (const cell of row.cells) Object.defineProperty(cell, 'innerText', {
              get() { window.__laterRowReads++; return getter.call(this); },
            });
          }
        });
        await page.locator('[data-action="check"]').click();
        await page.locator('[data-status]').getByText(/仅检查完成.*未找到符合条件/).waitFor({timeout:12000});
        assert.equal(await page.evaluate(() => window.__laterRowReads), 0);
        assert.equal(await page.evaluate(() => window.__submitted), 0);
        assert.equal(await page.locator('input[name="host"]:checked').count(), 0);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
        assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
      } finally { await context.close(); }
    });
  }
});

test('switches to the next stocked model when the first model has no qualifying top-three host', async () => {
  const {context,page} = await start('success', undefined, {}, {
    inventory:[{label:'FirstModel (1/20)'}, {label:'SecondModel (1/20)'}],
    hostModel:'FirstModel', goodIndex:3, autoStart:false,
  });
  try {
    await installDynamicModelFixture(page);
    await page.evaluate(() => {
      const second = [...document.querySelectorAll('#mock-model-inventory label')].find(label => label.textContent.startsWith('SecondModel'));
      second.addEventListener('change', () => {
        if (second.querySelector('input').checked) window.__showAvailableHost('SecondModel');
      });
    });
    await page.locator('[data-action="start"]').click();
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.deepEqual(await page.evaluate(() => window.__modelClicks), ['FirstModel (1/20)', 'SecondModel (1/20)']);
    assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost0');
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
  } finally { await context.close(); }
});

test('refresh restores the confirmed settings and locks controls during monitoring', async () => {
  const {context,page} = await start('no-stock', undefined, {refreshSeconds:9, maxHourlyCny:6.5});
  try {
    assert.equal(await page.locator('[data-setting="refreshSeconds"]').isDisabled(), true);
    assert.equal(await page.locator('[data-action="save"]').isDisabled(), true);
    await page.waitForEvent('load', {timeout:12000});
    await page.addScriptTag({path:path.join(__dirname,'core.js')});
    await page.addScriptTag({path:path.join(__dirname,'content.js')});
    await page.waitForFunction(() => document.querySelector('[data-setting="refreshSeconds"]')?.value === '9');
    assert.equal(await page.locator('[data-setting="maxHourlyCny"]').inputValue(), '6.5');
    assert.equal(await page.locator('[data-setting="refreshSeconds"]').isDisabled(), true);
    await page.locator('[data-action="stop"]').click();
  } finally { await context.close(); }
});

test('a pending submission from the previous extension version remains protected', async () => {
  const {context,page} = await start('success', undefined, {}, {legacyPending:true});
  try {
    assert.match(await page.locator('[data-status]').innerText(), /未核实/);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.ok(await page.evaluate(() => localStorage.getItem('autodl_clone_grab_pending_demo-source-12345678')));
  } finally { await context.close(); }
});

test('saved defaults persist across reload without starting a task', async () => {
  const {context,page} = await start('success', undefined, {minVramGB:72, refreshSeconds:11}, {autoStart:false});
  try {
    await page.locator('[data-action="save"]').click();
    await page.locator('[data-status]').getByText(/设置已保存/).waitFor();
    await page.reload();
    await page.addScriptTag({path:path.join(__dirname,'core.js')});
    await page.addScriptTag({path:path.join(__dirname,'content.js')});
    await page.waitForFunction(() => document.querySelector('[data-setting="minVramGB"]')?.value === '72');
    assert.equal(await page.locator('[data-setting="refreshSeconds"]').inputValue(), '11');
    assert.equal(await page.locator('[data-setting="refreshSeconds"]').isDisabled(), false);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('invalid settings cannot arm the watcher', async () => {
  const {context,page} = await start('success', undefined, {refreshSeconds:0});
  try {
    await page.locator('[data-status]').getByText(/刷新间隔必须/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_demo-source-12345678')), null);
  } finally { await context.close(); }
});

test('new rentals check a top-three host with the selected image and never submit in check mode', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true, checkOnly:true});
  try {
    await page.locator('[data-status]').getByText(/仅检查完成.*未创建实例/).waitFor({timeout:12000});
    assert.equal(await page.locator('.noMachine').count(), 0);
    assert.match(await page.locator('[data-source]').innerText(), /租用新服务器/);
    assert.equal(await page.locator('input[name="host"]:checked').inputValue(), 'mockhost2');
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.locator(IMAGE_SELECTOR).inputValue(), 'PyTorch / 2.8.0 / 3.12(ubuntu22.04) / 12.8');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockScrollRequests')), null);
  } finally { await context.close(); }
});

test('new rentals submit once and confirm the selected region and image', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true});
  try {
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    const confirm = await page.evaluate(() => window.__lastConfirm);
    assert.match(confirm, /租用新服务器.*西北B区/);
    assert.match(confirm, /基础镜像：PyTorch \/ 2.8.0 \/ 3.12\(ubuntu22.04\) \/ 12.8/);
    assert.doesNotMatch(confirm, /源实例/);
    assert.ok(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_new_instance')));
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_demo-source-12345678')), null);
  } finally { await context.close(); }
});

test('new rentals require a complete base image and refuse unsupported image modes', async t => {
  for (const option of [{imagePath:''}, {imagePath:'PyTorch / 2.8.0'}, {imageType:'customImage'}, {imageType:'CodeWithGPU'}]) {
    await t.test(JSON.stringify(option), async () => {
      const {context,page} = await start('success', undefined, {}, {create:true, ...option});
      try {
        await page.locator('[data-status]').getByText(/无法启动.*基础镜像/).waitFor({timeout:12000});
        assert.equal(await page.evaluate(() => window.__submitted), 0);
        assert.equal(await page.evaluate(() => window.__lastConfirm), undefined);
      } finally { await context.close(); }
    });
  }
});

test('a new rental stops if the image changes during host preparation', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true, autoStart:false});
  try {
    await page.evaluate(() => {
      document.querySelector('input[name="host"][value="mockhost2"]').addEventListener('change', () => {
        document.querySelector('#mock-image .el-cascader input').value = 'Miniconda / 2.8.0 / 3.12(ubuntu22.04) / 12.8';
      });
    });
    await page.locator('[data-action="start"]').click();
    await page.locator('[data-status]').getByText(/镜像已变化/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('__test_extension_storage__autodl_clone_grab_pending_new_instance')), null);
  } finally { await context.close(); }
});

test('a new rental requires the host to support the chosen image CUDA too', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true, checkOnly:true, imagePath:'PyTorch / 2.8.0 / 3.12(ubuntu22.04) / 14.0'});
  try {
    await page.locator('[data-status]').getByText(/仅检查完成.*未找到符合条件/).waitFor({timeout:12000});
    assert.equal(await page.locator('input[name="host"]:checked').count(), 0);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('a new rental restores the confirmed image and region after refresh before submitting', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true, autoStart:false});
  try {
    await page.locator(IMAGE_SELECTOR).evaluate(input => { input.value = 'Miniconda / 2.5.1 / 3.12(ubuntu22.04) / 12.8'; });
    await page.locator('input[value="test-other-region"]').click();
    await page.locator('[data-action="start"]').click();
    // Reload while waiting for the model/host, before any simulated order.
    await page.waitForFunction(() => sessionStorage.getItem('autodl_clone_grab_run_new_instance') === '1');
    await page.reload();
    assert.equal(await page.locator(IMAGE_SELECTOR).inputValue(), 'PyTorch / 2.8.0 / 3.12(ubuntu22.04) / 12.8');
    await injectExtension(page);
    await page.locator('[data-status]').getByText(/平台报告创建成功/).waitFor({timeout:12000});
    assert.equal(await page.locator(IMAGE_SELECTOR).inputValue(), 'Miniconda / 2.5.1 / 3.12(ubuntu22.04) / 12.8');
    assert.equal(await page.locator('input[value="test-other-region"]').isChecked(), true);
    assert.equal(await page.evaluate(() => window.__imageClicks), 4);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('mockTotalSubmitted')), '1');
  } finally { await context.close(); }
});

test('a missing saved rental image stops resumption before any paid click', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true, autoStart:false});
  try {
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(() => sessionStorage.getItem('autodl_clone_grab_run_new_instance') === '1');
    await page.reload();
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.endsWith('_context')) localStorage.removeItem(key);
    });
    await injectExtension(page);
    await page.locator('[data-status]').getByText(/原镜像或地区配置缺失/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('autodl_clone_grab_run_new_instance')), null);
  } finally { await context.close(); }
});

test('an unavailable saved image stops restoration without falling back to a default', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true, autoStart:false});
  try {
    await page.locator(IMAGE_SELECTOR).evaluate(input => { input.value = 'RemovedFramework / 2.8.0 / 3.12(ubuntu22.04) / 12.8'; });
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(() => sessionStorage.getItem('autodl_clone_grab_run_new_instance') === '1');
    await page.reload();
    await injectExtension(page);
    await page.locator('[data-status]').getByText(/原基础镜像选项已不可用：RemovedFramework/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});

test('new rental check-only interruptions never turn into paid monitoring after reload', async () => {
  const {context,page} = await start('success', undefined, {}, {create:true, autoStart:false});
  try {
    await page.evaluate(() => sessionStorage.setItem('autodl_clone_grab_run_new_instance', 'check'));
    await page.reload();
    await injectExtension(page);
    await page.locator('[data-status]').getByText(/上次仅检查已中断/).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally { await context.close(); }
});
