// 把 TAPD 真实数据 + 状态映射注入看板 HTML 模板，生成自包含看板
const fs = require('fs');
const stories = JSON.parse(fs.readFileSync('jd-stories-clean.json', 'utf8'));

const STATUS_MAP = {
  status_17:'待规划', planning:'提需完成', status_30:'需求分析中', status_12:'需求准备就绪',
  status_11:'待评审', status_36:'迭代评审完成', status_18:'待设计', status_32:'设计中',
  status_33:'设计完成', status_9:'待排期', status_2:'待开发', status_3:'开发中',
  status_35:'开发完成', status_40:'冒烟测试通过', status_4:'待测试', status_5:'测试中',
  status_6:'待UAT测试', status_7:'待发布', status_8:'待产品验收', status_14:'产品验收中',
  status_15:'产品验收完成', status_37:'待业务验收', status_38:'业务验收中', status_39:'业务验收完成',
  status_16:'验收不通过', resolved:'已实现', rejected:'已拒绝', status_10:'已暂缓', status_13:'评审不通过',
  status_20:'进行中', status_19:'未开始', status_21:'已完成', closed:'结束阶段',
  in_progress:'执行阶段', new:'开始阶段', workflow_suspended:'流程挂起', workflow_end:'流程终止'
};
const PRIO_SHORT = p => (p.match(/P[0-3]/) || [p])[0];

// 状态归一到看板进度组
function stageOf(s) {
  const n = STATUS_MAP[s.status] || s.status;
  if (['已完成','已实现','结束阶段','流程终止'].includes(n)) return 'done';
  if (['开发中','进行中','设计中','执行阶段','待UAT测试','测试中','待测试','冒烟测试通过','开发完成','设计完成'].includes(n)) return 'doing';
  if (['待发布','待产品验收','产品验收中','产品验收完成','待业务验收','业务验收中','业务验收完成','待评审','迭代评审完成','需求准备就绪','需求分析中','待规划','提需完成','待设计','待排期','待开发'].includes(n)) return 'review';
  if (['已拒绝','评审不通过','验收不通过','已暂缓','流程挂起'].includes(n)) return 'stopped';
  return 'other';
}

const items = stories.map((s, i) => ({
  id: s.short || ('R' + i),
  name: s.name,
  type: s.type,
  status: STATUS_MAP[s.status] || s.status,
  stage: stageOf(s),
  prio: PRIO_SHORT(s.priority),
  requester: s.requester || '—',
  line: s.line || '—',
  taskType: s.taskType || '',
  creator: s.creator || '',
  owner: s.owner || '',
  pm: (s.pm || '').replace(/;$/, ''),
  created: s.created || '',
  begin: s.begin || '',
  due: s.due || '',
  progress: parseInt(s.progress, 10) || 0,
  effort: s.effort || '',
  parent: s.parent && s.parent !== '0' ? s.parent.slice(-7) : '',
  url: s.url
}));

// 北京时间当天（UTC+8），保证逾期判断与默认月份随跑批日期滚动
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
function statsOf(b) {
  const done = b.filter(x => x.stage === 'done').length;
  const doing = b.filter(x => x.stage === 'doing').length;
  const review = b.filter(x => x.stage === 'review').length;
  const stopped = b.filter(x => x.stage === 'stopped').length;
  const overdue = b.filter(x => x.due && x.due < TODAY && x.stage !== 'done').length;
  return {
    total: b.length, done, doing, review, stopped, overdue,
    rate: b.length ? (done / b.length * 100).toFixed(1) : '0.0',
    risk: b.filter(x => x.requester === '风控' || x.line === '风险/反欺诈').length,
    debt: b.filter(x => x.requester === '催收').length,
    ops: b.filter(x => x.requester === '运营').length
  };
}
function trendOf(arr, days) {
  const end = new Date(TODAY + 'T00:00:00');
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const created = arr.filter(x => x.created && x.created <= key).length;
    const finished = arr.filter(x => (x.stage === 'done') && x.created && x.created <= key).length;
    out.push({ d: key, total: created, done: finished, rate: created ? +(finished / created * 100).toFixed(1) : 0 });
  }
  return out;
}
const TREND = trendOf(items, 30);

const board = buildBoard();
const STATS = statsOf(board);
const META = {
  generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
  workspace: '44381896',
  total: items.length,
  needs: items.filter(x => x.type === '需求').length,
  tasks: items.filter(x => x.type === '任务').length,
  stats: STATS,
  trend: TREND
};
const payload = JSON.stringify({ meta: META, board, items }, null, 0);

// 需求父项按 parent(=父id后7位) 聚合成看板主行；任务作为子节点展开
function buildBoard() {
  const needs = items.filter(x => x.type === '需求');
  const tasksByParent = {};
  items.filter(x => x.type === '任务').forEach(t => {
    const k = t.parent || '(未挂需求)';
    (tasksByParent[k] = tasksByParent[k] || []).push(t);
  });
  return needs.map(n => {
    const children = tasksByParent[n.id] || [];
    return {
      ...n,
      children: children.map(c => ({
        id: c.id, name: c.name.replace(/^【[^】]*】/, '').replace(/^【JD】/, ''),
        taskType: c.taskType, owner: c.owner, status: c.status,
        begin: c.begin, due: c.due, progress: c.progress, url: c.url
      }))
    };
  });
}

let html = fs.readFileSync('kanban-template.html', 'utf8');
html = html.replace('/*__DATA__*/', 'const DATA = ' + payload + ';');
fs.mkdirSync('site', { recursive: true });
fs.writeFileSync('jd-tapd-kanban-live.html', html, 'utf8');   // 本地预览
fs.writeFileSync('site/index.html', html, 'utf8');            // GitHub Pages 入口
console.log('生成 jd-tapd-kanban-live.html');
console.log('元信息:', JSON.stringify(META));
console.log('看板主行(需求):', board.length, ' 带子任务的需求:', board.filter(x => x.children.length).length);
