/* Shared decision logic. It never accesses a browser, network, or credentials. */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.AutoDLCloneGrabCore = core;
})(globalThis, function () {
  'use strict';

  const LIMITS = Object.freeze({
    minVramGB: 48,
    minExpandableGB: 300,
    expandGB: 300,
    maxHourlyCny: 7,
    minCudaMajor: 12,
    minCudaMinor: 8,
    requestedGPUs: 1,
    refreshSeconds: 5,
  });

  // Standard desktop memory (the upper bound where a name has variants).
  // Sources and modified-card precedence are documented in 使用说明.md.
  const STANDARD_VRAM_GB = Object.freeze({
    RTX2080TI:11, RTX2080SUPER:8, RTX2080:8, RTX2070SUPER:8, RTX2070:8, RTX2060SUPER:8, RTX2060:12,
    RTX3090TI:24, RTX3090:24, RTX3080TI:12, RTX3080:12, RTX3070TI:8, RTX3070:8, RTX3060TI:8, RTX3060:12, RTX3050:8,
    RTX4090:24, RTX4090D:24, RTX4080SUPER:16, RTX4080:16, RTX4070TISUPER:16, RTX4070TI:12, RTX4070SUPER:12, RTX4070:12, RTX4060TI:16, RTX4060:8,
    RTX5090:32, RTX5090D:32, RTX5090DV2:24, RTX5080:16, RTX5070TI:16, RTX5070:12, RTX5060TI:16, RTX5060:8, RTX5050:8,
    RTXA6000:48, A6000:48, RTX6000ADA:48, RTX6000ADAGENERATION:48,
    L40:48, L40S:48, L4:24, A40:48, A10:24,
    RTXPRO6000:96, RTXPRO6000BLACKWELL:96, RTXPRO6000BLACKWELLSERVEREDITION:96, RTXPRO6000BLACKWELLWORKSTATIONEDITION:96,
  });

  function cloneSourceId(url) {
    const u = new URL(url);
    if (u.origin !== 'https://www.autodl.com' || u.pathname !== '/cloneInstance') {
      throw new Error('当前页面不是 AutoDL 克隆页');
    }
    const ids = u.searchParams.getAll('id');
    if (ids.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9-]{3,127}$/.test(ids[0])) {
      throw new Error('克隆链接缺少有效且唯一的源实例 ID，请从实例列表重新打开克隆页');
    }
    return ids[0];
  }

  function validateSettings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设置格式无效');
    const result = {};
    for (const name of Object.keys(LIMITS)) {
      const value = raw[name];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('设置必须是有效数字');
      result[name] = value;
    }
    const integerBetween = (name, min, max, label) => {
      const value = result[name];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(label + '必须是 ' + min + '–' + max + ' 的整数');
    };
    integerBetween('minVramGB', 1, 1024, '最低单卡显存');
    integerBetween('minExpandableGB', 0, 100000, '最低可扩容容量');
    integerBetween('expandGB', 0, 100000, '实际扩容容量');
    integerBetween('refreshSeconds', 1, 3600, '刷新间隔');
    integerBetween('minCudaMajor', 10, 20, 'CUDA 主版本');
    integerBetween('minCudaMinor', 0, 99, 'CUDA 次版本');
    if (result.requestedGPUs !== 1) throw new Error('目前只支持单卡');
    if (result.maxHourlyCny <= 0 || result.maxHourlyCny > 1000000) throw new Error('每小时价格上限必须大于 0');
    return Object.freeze(result);
  }

  function parseHost(cells, selectable) {
    if (!Array.isArray(cells) || cells.length !== 9) return null;
    const [id, hostName, gpuCell, freeCell, allocation, cpu, diskCell, cudaCell, priceCell] = cells.map(String);
    const hostId = id.trim();
    if (!/^[a-zA-Z0-9-]{4,64}$/.test(hostId)) return null;
    const lines = gpuCell.trim().split(/\n+/).map(s => s.trim()).filter(Boolean);
    const vramValues = [...gpuCell.matchAll(/(\d+(?:\.\d+)?)\s*G(?:i)?B\b/gi)];
    const available = freeCell.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
    const expansion = diskCell.match(/可扩容\s*[：:]\s*([\d,]+(?:\.\d+)?)\s*G(?:i)?B\b/i);
    const cuda = cudaCell.match(/CUDA\s*[：:]\s*(\d+)\.(\d+)\b/i);
    // The first /hour price is the current price shown in the page's price cell.
    const currentPriceLine = priceCell.split(/\n/).map(line => line.trim()).find(Boolean) || '';
    const price = currentPriceLine.match(/[￥¥]\s*(\d+(?:\.\d+)?)\s*\/\s*(?:时|小时|h)/i);
    if (!lines.length || !vramValues.length || !available || !expansion || !cuda || !price) return null;
    const host = {
      id: hostId,
      hostName: hostName.trim(),
      model: lines[0],
      vramGB: Number(vramValues[vramValues.length - 1][1]),
      freeGPUs: Number(available[1]),
      totalGPUs: Number(available[2]),
      expandableGB: Number(expansion[1].replace(/,/g, '')),
      cudaMajor: Number(cuda[1]),
      cudaMinor: Number(cuda[2]),
      hourlyCny: Number(price[1]),
      selectable: selectable === true,
      allocation: allocation.trim(),
      cpu: cpu.trim(),
    };
    if (!Object.values(host).every(v => typeof v !== 'number' || Number.isFinite(v))) return null;
    if (host.freeGPUs > host.totalGPUs || host.totalGPUs < 1) return null;
    // CUDA 99 / placeholder values are not reliable driver compatibility evidence.
    if (host.cudaMajor < 10 || host.cudaMajor > 20 || host.cudaMinor > 99) return null;
    return host;
  }

  function qualifies(host, limits = LIMITS) {
    if (!host || host.selectable !== true) return false;
    return host.vramGB >= limits.minVramGB &&
      host.freeGPUs >= limits.requestedGPUs &&
      host.expandableGB >= limits.minExpandableGB &&
      host.expandableGB >= limits.expandGB &&
      host.hourlyCny > 0 && host.hourlyCny <= limits.maxHourlyCny &&
      (host.cudaMajor > limits.minCudaMajor ||
        (host.cudaMajor === limits.minCudaMajor && host.cudaMinor >= limits.minCudaMinor));
  }

  function parseModelChoice(label) {
    // The visible label is authoritative; checkbox values can be opaque IDs.
    const match = String(label).trim().match(/^([\s\S]+?)\s*[(（]\s*(\d+)\s*\/\s*(\d+)\s*[)）]$/);
    if (!match) return null;
    const name = match[1].trim(), free = Number(match[2]), total = Number(match[3]);
    if (!name || !Number.isSafeInteger(free) || !Number.isSafeInteger(total) || free > total) return null;
    return { name, free, total };
  }

  function stockedModelChoices(choices, limits = LIMITS) {
    return choices.filter(choice => choice.free >= limits.requestedGPUs &&
      choice.disabled !== true && modelMayMeetVram(choice.name, limits));
  }

  function modelKey(name) {
    return String(name).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  }

  function modelMayMeetVram(name, limits = LIMITS) {
    const text = String(name).normalize('NFKC').trim();
    if (/^CPU(?:$|[-_\s])/i.test(text)) return false;
    // Explicit memory overrides standard specs, e.g. RTX 4090-48GB.
    const capacities = [...text.matchAll(/(\d+(?:\.\d+)?)\s*G(?:iB|B)?(?=$|[^a-z0-9.])/gi)].map(match => Number(match[1]));
    if (capacities.length) return Math.max(...capacities) >= limits.minVramGB;
    const key = modelKey(text).replace(/[™®]/g, '').replace(/^(?:NVIDIA)?(?:GEFORCE|QUADRO)?/, '').replace(/[-_]/g, '');
    if (Object.hasOwn(STANDARD_VRAM_GB, key)) return STANDARD_VRAM_GB[key] >= limits.minVramGB;
    // Unknown regional models still need actual page specs; never guess a size.
    return true;
  }

  function definiteStockFailure(text) {
    const t = String(text).normalize('NFKC').trim().replace(/\s+/g, '').replace(/^错误[:：]?/, '');
    if (/^(?:当前)?GPU库存发生变更[,，]请刷新后重新选择[。.!！]?$/.test(t)) return true;
    return /^(?:(?:创建实例|创建|开机)失败[：:])?(?:(?:当前|该)?(?:主机|机器)?(?:可用|空闲)?GPU(?:资源|数量|库存)?不足|GPU(?:资源|数量|库存)?不足|(?:当前|该)?(?:主机|机器)?(?:库存不足|无空闲GPU|无可用GPU))(?:[，,。.!！](?:请更换主机|请更换机器|请稍后重试|请重试|请重新选择))?[。.!！]?$/.test(t);
  }

  // Both paid creation and the check-only run verify the same live form.
  async function prepareOne(candidate, adapter, limits = LIMITS) {
    limits = validateSettings(limits);
    if (!qualifies(candidate, limits)) throw new Error('候选主机不满足筛选条件');
    await adapter.selectHost(candidate.id);
    await adapter.setExpansion(limits.expandGB);
    const current = await adapter.readHost(candidate.id);
    if (!qualifies(current, limits) || current.id !== candidate.id) throw new Error('主机库存、价格或规格已变化');
    await adapter.verifyForm(current, limits);
    return current;
  }

  // The adapter owns DOM operations; ledger persists the irreversible boundary.
  async function submitOne(candidate, adapter, ledger, limits = LIMITS) {
    limits = validateSettings(limits);
    const current = await prepareOne(candidate, adapter, limits);
    if (await ledger.getPending()) throw new Error('已有提交结果未核实，请先检查实例列表');
    // Storage is durable before the click. If interrupted, retain the marker.
    await ledger.markPending({ hostId: current.id, model: current.model, vramGB: current.vramGB,
      price: current.hourlyCny, expandGB: limits.expandGB, at: new Date().toISOString() });
    adapter.submit();
    return current;
  }

  return { LIMITS, cloneSourceId, validateSettings, parseHost, qualifies, parseModelChoice, stockedModelChoices, modelKey, modelMayMeetVram, definiteStockFailure, prepareOne, submitOne };
});
