/*
 * 思源网盘 (siyuan-netdisk) - 思源插件
 * 作者：qiancang
 *
 * 像网盘一样浏览 data/assets：目录树 / 类型分类 / 文件名搜索（不触发下载）
 * 列表与缩略图视图、图片双指缩放、资源按需下载、
 * 文件的历史版本（来自「数据快照」）、手机端另存为 / 用其它应用打开、批量操作。
 *
 * 入口：
 *   桌面端：只注册顶栏按钮，点击打开一个「思源网盘」自定义页签（不注册侧边栏 Dock）
 *   手机端：只注册停靠栏面板（设置菜单的「扩展」分组 / 底部导航），不使用页签
 *
 * 未下载资源的数据来源（参考思源自身实现 model.SearchAssetsByName / DeferredSyncAssets）：
 *   1) data/assets 递归遍历 -> 本地已下载文件（/api/file/readDir）
 *   2) 内核 SQLite 资源索引 assets 表 -> 所有被引用的资源（含云端未下载）
 *   3) /api/search/searchAsset -> 本地 + DeferredSyncAssets（受“搜索结果显示数”限制）
 *   （2 ∪ 3）－（1）＝ 未下载 / 已丢失资源
 *   再用 /api/asset/statAsset 逐个确认（downloaded === false 才是真正的未下载）。
 *
 * 历史版本（数据快照，不用 data/history）：
 *   POST /api/repo/searchRepoFile  {keyword=文件名, page} -> 该文件在各快照中的每个内容版本
 *   POST /api/repo/getRepoFile     {id=fileID}  -> 该版本文件的原始字节（非 JSON）
 *   POST /api/repo/rollbackRepoSnapshotFile {id=fileID} -> 还原该版本
 *   只有 1 个内容版本的文件不提示、菜单里也不显示历史版本。
 *
 * 移动端（照搬思源自身实现，见 app/src/protyle/util/compatibility.ts 的 saveExportFile）：
 *   用其它应用打开 -> JSAndroid.openExternal("assets/xxx")（相对路径）
 *   另存为         -> JSAndroid.saveExportFileV2(uri, requestID) / saveExportFile(uri)
 *                     iOS: webkit.messageHandlers.saveExportFile(V2)
 *                     Harmony: JSHarmony.saveExportFile(V2)
 *                     其它环境: window.open(同源 URL + "?download=true")
 *   （exportByDefault / 浏览器下载会把地址交给系统浏览器，被内核跨站校验拒绝；
 *     移动端也没有系统分享桥，故不提供“分享到 IM”。）
 *
 * 删除保护（拒绝式）：同时拦截 window.fetch 与 XMLHttpRequest，命中
 *   /api/file/removeFile、/api/asset/removeUnusedAsset(s)
 * 且目标位于“网盘目录”下时直接拒绝，思源本体、其它插件都无法删除；
 * 只有本插件的面板可以删除。
 *
 * 无构建 CommonJS 产物，直接由思源加载。
 */
const {
  Plugin,
  Dialog,
  Setting,
  confirm,
  showMessage,
  fetchSyncPost,
  getFrontend,
  openTab,
  openMobileFileById,
  Constants,
} = require("siyuan");

/* ========================= 常量 ========================= */
const NS = "am";
const ASSETS_REL = "assets";
const TAB_TYPE = "tab"; // 自定义页签 type，实际 id 为 <pluginName><TAB_TYPE>
const PAGE_SIZE = 100;
const STAT_MAX = 150;
const MISS_STAT_MAX = 60;
const SCAN_MAX_FILES = 40000;
const SCAN_MAX_DIRS = 4000;
const SQL_PAGE = 1000;
const SQL_MAX_PAGES = 30;
const INDEX_TTL = 60 * 1000;
const CONFIG_FILE = "config.json";
const PLUGIN_TITLE = "思源网盘";
const TAG = "[思源网盘]";

// 数据快照版本
const VER_TTL = 5 * 60 * 1000;
const VER_MAX_PAGES = 3;
const VER_PREFETCH_MAX = 40;
const VER_FILTER_MAX = 200;
const VER_MIN_SHOW = 2; // 至少 2 个内容版本才提示/显示“历史版本”

const SAVE_TIMEOUT = 120 * 1000; // 等待移动端“另存为”回调的超时

const TYPE_DEFS = [
  { key: "all", label: "全部", exts: null },
  { key: "image", label: "图片", exts: "jpg jpeg jpe jfif png gif bmp webp svg ico avif tiff tif heic heif apng".split(" ") },
  { key: "video", label: "视频", exts: "mp4 mov avi mkv webm flv wmv m4v mpeg mpg 3gp ts mts".split(" ") },
  { key: "audio", label: "音频", exts: "mp3 wav flac aac ogg m4a wma opus aiff".split(" ") },
  { key: "pdf", label: "PDF", exts: ["pdf"] },
  { key: "word", label: "Word", exts: "doc docx rtf odt wps".split(" ") },
  { key: "excel", label: "Excel", exts: "xls xlsx csv ods et".split(" ") },
  { key: "ppt", label: "PPT", exts: "ppt pptx odp dps".split(" ") },
  { key: "text", label: "文本", exts: "txt md markdown json xml html htm css js ts go py java yaml yml log ini sh bat sql".split(" ") },
  { key: "archive", label: "压缩", exts: "zip rar 7z tar gz bz2 xz".split(" ") },
  { key: "other", label: "其他", exts: [] },
];

const EXT2TYPE = {};
const TYPE_LABEL = {};
TYPE_DEFS.forEach(function (d) {
  TYPE_LABEL[d.key] = d.label;
  if (d.exts && d.exts.length) {
    d.exts.forEach(function (e) {
      EXT2TYPE[e] = d.key;
    });
  }
});

/* ========================= 工具函数 ========================= */
function extOf(name) {
  const s = String(name == null ? "" : name);
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(i + 1).toLowerCase() : "";
}

function classify(name) {
  return EXT2TYPE[extOf(name)] || "other";
}

function isImageName(name) {
  return classify(name) === "image";
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === '"') return "&quot;";
    return "&#39;";
  });
}

function basename(p) {
  const s = String(p == null ? "" : p).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function dirname(p) {
  const s = String(p == null ? "" : p);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : s;
}

function segs(p) {
  return String(p == null ? "" : p)
    .split("/")
    .filter(function (s) {
      return s !== "";
    });
}

/** 路径 -> 可直接访问的 URL（逐段编码，兼容中文/空格文件名） */
function assetURL(rel) {
  return "/" + segs(rel).map(encodeURIComponent).join("/");
}

function originURL() {
  try {
    return location.protocol + "//" + location.host;
  } catch (e) {
    return "";
  }
}

function absURL(rel) {
  return originURL() + assetURL(rel);
}

function repoPath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeHomePath(v) {
  let s = String(v == null ? "" : v).trim().replace(/\\/g, "/");
  s = s.replace(/^data\//i, "");
  s = s.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  if (s.indexOf("..") >= 0 || s === "") s = ASSETS_REL;
  if (s !== ASSETS_REL && s.indexOf(ASSETS_REL + "/") !== 0) {
    if (s.indexOf(ASSETS_REL) === 0) {
      s = ASSETS_REL + "/" + s.slice(ASSETS_REL.length).replace(/^\/+/, "");
    } else {
      s = ASSETS_REL + "/" + s;
    }
  }
  return s;
}

function toRelPath(p) {
  let s = String(p == null ? "" : p).trim().replace(/\\/g, "/");
  s = s.replace(/^\/+/, "");
  if (s.indexOf("data/") === 0) s = s.slice(5);
  return s;
}

function sizeText(n) {
  if (n === undefined || n === null || n === "") return "";
  let v = Number(n);
  if (!isFinite(v) || v < 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v = v / 1024;
    i++;
  }
  if (i === 0) return String(v) + " " + u[i];
  return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + " " + u[i];
}

function pad2(x) {
  return x < 10 ? "0" + x : String(x);
}

function toDate(ts) {
  if (!ts) return null;
  let n = Number(ts);
  if (!isFinite(n) || n <= 0) return null;
  if (n < 100000000000) n = n * 1000;
  const d = new Date(n);
  return isNaN(d.getTime()) ? null : d;
}

function dateText(ts) {
  const d = toDate(ts);
  if (!d) return "";
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function dateTimeText(ts) {
  const d = toDate(ts);
  if (!d) return "";
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
  );
}

function genId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function copyText(text) {
  return new Promise(function (resolve) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            resolve(true);
          },
          function () {
            resolve(fallbackCopy(text));
          }
        );
        return;
      }
    } catch (e) {
      /* ignore */
    }
    resolve(fallbackCopy(text));
  });
}

async function api(url, data) {
  let res = null;
  try {
    res = await fetchSyncPost(url, data || {});
  } catch (e) {
    throw new Error(e && e.message ? e.message : String(e));
  }
  if (res && res.code === 0) return res.data;
  const err = new Error((res && res.msg) || "请求失败：" + url);
  err.res = res;
  throw err;
}

function blockedResponse(msg) {
  try {
    return new Response(JSON.stringify({ code: -1, msg: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return Promise.reject(new Error(msg));
  }
}

function fixDialogLayout(dialog) {
  try {
    const container = dialog.element.querySelector(".b3-dialog__container");
    const body = dialog.element.querySelector(".b3-dialog__body");
    const content = dialog.element.querySelector(".b3-dialog__content");
    if (container) {
      container.style.display = "flex";
      container.style.flexDirection = "column";
    }
    if (body) {
      body.style.padding = "0";
      body.style.overflow = "hidden";
      body.style.display = "flex";
      body.style.flexDirection = "column";
    }
    if (content) {
      content.style.padding = "0";
      content.style.margin = "0";
      content.style.height = "100%";
      content.style.minHeight = "0";
      content.style.display = "flex";
      content.style.flexDirection = "column";
      content.style.overflow = "hidden";
    }
  } catch (e) {
    /* ignore */
  }
}

/* ========================= 资源浏览器 UI ========================= */
class AssetBrowser {
  constructor(plugin, container) {
    this.plugin = plugin;
    this.root = container;
    this.root.classList.add(NS + "-root");
    this.isMobile = !!plugin.isMobile;
    this.destroyed = false;
    this._nodes = new Map();
    this._overlay = null;
    this._sheetPath = "";
    this._previewPath = "";
    this._objUrls = [];
    this.state = {
      dir: plugin.homePath || ASSETS_REL,
      type: "all",
      search: "",
      onlyMissing: false,
      onlyHistory: false,
      view: "list",
      sort: "name-asc",
      selected: new Set(),
      deleted: new Set(),
      local: [],
      localSet: new Set(),
      dirs: new Set(),
      remote: new Map(),
      notLocal: [],
      remoteDirs: new Set(),
      verPending: new Set(),
      items: [],
      limit: PAGE_SIZE,
      reqId: 0,
      statToken: 0,
      busy: false,
    };
    this.buildSkeleton();
    this.bind();
  }

  destroy() {
    this.destroyed = true;
    this.state.reqId++;
    this.state.statToken++;
    this.closeOverlay();
    this._nodes = new Map();
  }

  async start() {
    await this.refresh(false);
  }

  body() {
    return this.root ? this.root.querySelector("#" + NS + "-body") : null;
  }

  /* ---------------- 骨架与事件 ---------------- */
  buildSkeleton() {
    const chips = TYPE_DEFS.map(function (d) {
      return (
        '<button class="' + NS + '-chip" data-act="type" data-value="' + d.key + '">' + esc(d.label) + "</button>"
      );
    }).join("");

    this.root.innerHTML = [
      '<div class="' + NS + '-bar">',
      '<button class="' + NS + '-icon" data-act="up" title="上一级">↑</button>',
      '<button class="' + NS + '-icon" data-act="home" title="网盘目录">⌂</button>',
      '<div class="' + NS + '-crumbs" id="' + NS + '-crumbs"></div>',
      '<button class="' + NS + '-icon" data-act="refresh" title="刷新索引">⟳</button>',
      '<button class="' + NS + '-icon" data-act="view" id="' + NS + '-viewbtn" title="切换列表/缩略图">☰</button>',
      '<button class="' + NS + '-icon" data-act="settings" title="设置">⚙</button>',
      "</div>",

      '<div class="' + NS + '-tools">',
      '<input class="' + NS + '-input" id="' + NS + '-search" type="search" autocomplete="off" placeholder="搜索文件名（不会触发下载）" />',
      '<select class="' + NS + '-select" id="' + NS + '-sort">',
      '<option value="name-asc">名称 ↑</option>',
      '<option value="name-desc">名称 ↓</option>',
      '<option value="time-desc">时间 ↓ 新→旧</option>',
      '<option value="time-asc">时间 ↑ 旧→新</option>',
      "</select>",
      "</div>",

      '<div class="' + NS + '-chips" id="' + NS + '-chips">' +
        chips +
        '<button class="' + NS + '-chip" data-act="onlyMissing">仅未下载</button>' +
        '<button class="' + NS + '-chip" data-act="onlyHistory">有历史版本</button>' +
        "</div>",

      '<div class="' + NS + '-info" id="' + NS + '-info"></div>',
      '<div class="' + NS + '-body" id="' + NS + '-body"></div>',

      '<div class="' + NS + '-foot">',
      '<button class="' + NS + '-btn" data-act="selectAll">全选/取消</button>',
      '<span class="' + NS + '-count" id="' + NS + '-selcount">已选 0</span>',
      '<span class="' + NS + '-spacer"></span>',
      '<button class="' + NS + '-btn" data-act="batch-download">批量下载</button>',
      '<button class="' + NS + '-btn" data-act="batch-copy">复制路径</button>',
      '<button class="' + NS + '-btn ' + NS + '-btn--danger" data-act="batch-delete">删除</button>',
      "</div>",
    ].join("");

    this.renderHome();
    this.renderBar();
  }

  renderHome() {
    const btn = this.root.querySelector('[data-act="home"]');
    if (btn) btn.setAttribute("title", "网盘目录：" + (this.plugin.homePath || ASSETS_REL));
  }

  renderBar() {
    const btn = this.root.querySelector("#" + NS + "-viewbtn");
    if (btn) btn.textContent = this.state.view === "grid" ? "▦" : "☰";
  }

  bind() {
    const root = this.root;
    root.addEventListener("click", (ev) => this.onClick(ev));
    root.addEventListener("change", (ev) => this.onChange(ev));
    root.addEventListener("error", (ev) => this.onImgError(ev), true);

    const search = root.querySelector("#" + NS + "-search");
    if (search) {
      let timer = 0;
      search.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (this.destroyed) return;
          this.state.search = search.value || "";
          this.state.selected.clear();
          this.refresh(false);
        }, 260);
      });
    }

    const sort = root.querySelector("#" + NS + "-sort");
    if (sort) {
      sort.addEventListener("change", () => {
        if (this.destroyed) return;
        this.state.sort = sort.value;
        this.refresh(false);
      });
    }
  }

  /* ---------------- 索引：本地 + 内核资源索引 ---------------- */
  async walkAll() {
    const files = [];
    const dirs = new Set();
    const stack = [ASSETS_REL];
    const seen = new Set([ASSETS_REL]);
    let visited = 0;
    while (stack.length) {
      if (this.destroyed) break;
      const d = stack.pop();
      visited++;
      if (visited > SCAN_MAX_DIRS || files.length > SCAN_MAX_FILES) break;
      let entries;
      try {
        entries = await api("/api/file/readDir", { path: "/data/" + d });
      } catch (e) {
        continue;
      }
      const list = entries || [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || !e.name || e.name.charAt(0) === "." || /\.sya$/i.test(e.name)) continue;
        const p = d + "/" + e.name;
        if (e.isDir) {
          if (e.isSymlink) continue;
          dirs.add(p);
          if (!seen.has(p)) {
            seen.add(p);
            stack.push(p);
          }
        } else {
          files.push({ path: p, name: e.name, updated: e.updated });
        }
      }
    }
    files.sort(function (a, b) {
      return a.path.localeCompare(b.path);
    });
    return { files: files, dirs: dirs };
  }

  async fetchRemote() {
    const map = new Map();
    try {
      for (let page = 0; page < SQL_MAX_PAGES; page++) {
        if (this.destroyed) break;
        const rows = await api("/api/query/sql", {
          stmt:
            "SELECT path, block_id FROM assets WHERE path LIKE 'assets/%' LIMIT " +
            SQL_PAGE +
            " OFFSET " +
            page * SQL_PAGE,
        });
        if (!rows || !rows.length) break;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const p = r && r.path ? String(r.path) : "";
          if (!p || p.charAt(0) === "." || map.has(p)) continue;
          map.set(p, { path: p, name: basename(p), blockId: r.block_id ? String(r.block_id) : "" });
        }
        if (rows.length < SQL_PAGE) break;
      }
    } catch (e) {
      /* 只读 / 发布模式下 SQL 不可用 */
    }
    try {
      const list = await api("/api/search/searchAsset", { k: "", exts: [] });
      const arr = list || [];
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i] && arr[i].path ? String(arr[i].path) : "";
        if (!p || map.has(p)) continue;
        map.set(p, { path: p, name: basename(p), blockId: "" });
      }
    } catch (e) {
      /* ignore */
    }
    return map;
  }

  async ensureIndex(force) {
    const st = this.state;
    const cache = this.plugin._indexCache;
    const fresh = cache && Date.now() - cache.ts < INDEX_TTL;
    if (!force && fresh) {
      st.local = cache.local;
      st.localSet = cache.localSet;
      st.dirs = cache.dirs;
      st.remote = cache.remote;
    } else {
      const walked = await this.walkAll();
      if (this.destroyed) return;
      const local = walked.files;
      const localSet = new Set(
        local.map(function (f) {
          return f.path;
        })
      );
      const remote = await this.fetchRemote();
      if (this.destroyed) return;
      this.plugin._indexCache = { ts: Date.now(), local: local, localSet: localSet, dirs: walked.dirs, remote: remote };
      st.local = local;
      st.localSet = localSet;
      st.dirs = walked.dirs;
      st.remote = remote;
    }
    const notLocal = [];
    st.remote.forEach(function (v) {
      if (!st.localSet.has(v.path)) notLocal.push(v);
    });
    st.notLocal = notLocal;
    const remoteDirs = new Set();
    notLocal.forEach(function (v) {
      const parts = segs(dirname(v.path));
      for (let i = 2; i <= parts.length; i++) remoteDirs.add(parts.slice(0, i).join("/"));
    });
    st.remoteDirs = remoteDirs;
  }

  /* ---------------- 数据快照：文件的历史版本 ---------------- */
  async versionsOf(path, fetch) {
    const cache = this.plugin._verCache;
    const hit = cache.get(path);
    if (hit && Date.now() - hit.ts < VER_TTL) return hit.list;
    if (!fetch) return hit ? hit.list : null;
    if (this.state.verPending.has(path)) return hit ? hit.list : null;
    this.state.verPending.add(path);
    const list = [];
    const seen = new Set();
    const name = basename(path);
    try {
      for (let page = 1; page <= VER_MAX_PAGES; page++) {
        const res = await api("/api/repo/searchRepoFile", { keyword: name, page: page });
        const files = (res && res.files) || [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (!f || !f.fileID) continue;
          if (repoPath(f.path) !== path) continue;
          if (seen.has(f.fileID)) continue;
          seen.add(f.fileID);
          list.push({
            fileID: f.fileID,
            snapshotID: f.indexID || "",
            path: repoPath(f.path),
            hSize: f.hSize || "",
            updated: f.updated || 0,
            title: f.title || name,
          });
        }
        const pageCount = (res && res.pageCount) || 1;
        if (page >= pageCount) break;
      }
      list.sort(function (a, b) {
        return (Number(b.updated) || 0) - (Number(a.updated) || 0);
      });
    } catch (e) {
      console.log(TAG + " 查询快照版本失败（" + path + "）：" + ((e && e.message) || e));
      return null;
    }
    this.state.verPending.delete(path);
    cache.set(path, { ts: Date.now(), list: list });
    return list;
  }

  /** 已缓存的版本数；未知返回 null */
  verCount(path) {
    const hit = this.plugin._verCache.get(path);
    if (!hit) return null;
    if (Date.now() - hit.ts > VER_TTL) return null;
    return hit.list.length;
  }

  /** 是否值得提示“历史 N 版”（≥2 个内容版本）；不满足返回 0 */
  verShow(path) {
    const n = this.verCount(path);
    return n !== null && n >= VER_MIN_SHOW ? n : 0;
  }

  /** 菜单里是否显示“历史版本”：已知 <2 个则不显示 */
  showHistoryEntry(path) {
    const n = this.verCount(path);
    if (n === null) return true; // 还没查到，先显示，点开时按需再查
    return n >= VER_MIN_SHOW;
  }

  async prefetchVersions(paths, limit) {
    const list = [];
    const seen = new Set();
    (paths || []).forEach((p) => {
      if (!p || seen.has(p)) return;
      if (this.verCount(p) !== null) return;
      seen.add(p);
      list.push(p);
    });
    const max = limit || VER_PREFETCH_MAX;
    const targets = list.slice(0, max);
    if (!targets.length) return;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        if (this.destroyed) return;
        const p = targets[idx++];
        await this.versionsOf(p, true);
        if (this.destroyed) return;
        this.paintMeta(p);
        this.renderInfo();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  /* ---------------- 列表构建 ---------------- */
  buildDirItems(rel) {
    const st = this.state;
    const items = [];
    const names = new Set();

    st.dirs.forEach(function (d) {
      if (dirname(d) !== rel) return;
      const nm = basename(d);
      if (names.has(nm)) return;
      names.add(nm);
      items.push({ path: d, name: nm, kind: "dir" });
    });

    st.local.forEach(function (f) {
      if (dirname(f.path) !== rel || st.deleted.has(f.path)) return;
      if (names.has(f.name)) return;
      names.add(f.name);
      items.push({ path: f.path, name: f.name, kind: "file", local: true, updated: f.updated });
    });

    st.remoteDirs.forEach(function (d) {
      if (dirname(d) !== rel) return;
      const nm = basename(d);
      if (names.has(nm)) return;
      names.add(nm);
      items.push({ path: d, name: nm, kind: "dir", virtual: true });
    });

    st.notLocal.forEach(function (v) {
      if (st.deleted.has(v.path) || dirname(v.path) !== rel) return;
      const nm = basename(v.path);
      if (names.has(nm)) return;
      names.add(nm);
      items.push({ path: v.path, name: nm, kind: "file", local: false, remote: v });
    });

    return this.sortItems(items);
  }

  buildFlatItems() {
    const st = this.state;
    const items = [];
    const seen = new Set();
    st.local.forEach(function (f) {
      if (st.deleted.has(f.path) || seen.has(f.path)) return;
      seen.add(f.path);
      items.push({ path: f.path, name: f.name, kind: "file", local: true, updated: f.updated });
    });
    st.notLocal.forEach(function (v) {
      if (st.deleted.has(v.path) || seen.has(v.path)) return;
      seen.add(v.path);
      items.push({ path: v.path, name: v.name, kind: "file", local: false, remote: v });
    });

    const q = st.search.trim().toLowerCase();
    const type = st.type;
    const onlyMissing = !!st.onlyMissing;
    const onlyHistory = !!st.onlyHistory;
    const self = this;
    const out = items.filter(function (it) {
      if (type !== "all" && classify(it.name) !== type) return false;
      if (q && it.name.toLowerCase().indexOf(q) < 0 && it.path.toLowerCase().indexOf(q) < 0) return false;
      if (onlyMissing && it.local !== false) return false;
      if (onlyHistory && !self.verShow(it.path)) return false;
      return true;
    });
    return this.sortItems(out);
  }

  sortItems(items) {
    const s = this.state ? this.state.sort : "name-asc";
    const byName = function (a, b) {
      return String(a.name).localeCompare(String(b.name), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
    };
    const dirs = items.filter(function (i) {
      return i.kind === "dir";
    });
    dirs.sort(byName);
    const files = items.filter(function (i) {
      return i.kind !== "dir";
    });
    if (s === "name-desc") files.sort(function (a, b) { return -byName(a, b); });
    else if (s === "time-desc") files.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    else if (s === "time-asc") files.sort(function (a, b) { return (a.updated || 0) - (b.updated || 0); });
    else files.sort(byName);
    return dirs.concat(files);
  }

  findItem(path) {
    const st = this.state;
    if (!st || !st.items) return null;
    for (let i = 0; i < st.items.length; i++) {
      if (st.items[i].path === path) return st.items[i];
    }
    return null;
  }

  isFlat() {
    const st = this.state;
    return !!st.search.trim() || st.type !== "all" || !!st.onlyMissing || !!st.onlyHistory;
  }

  /* ---------------- 渲染 ---------------- */
  async refresh(force) {
    const st = this.state;
    if (this.destroyed) return;
    const reqId = (st.reqId = st.reqId + 1);
    st.limit = PAGE_SIZE;
    st.selected.clear();
    if (force) {
      st.deleted.clear();
      this.plugin._verCache.clear();
    }
    this.renderChips();
    this.renderBar();
    const known = this.plugin._indexCache && this.plugin._indexCache.local && this.plugin._indexCache.remote;
    if (!known) {
      const empty = this.body();
      if (empty) empty.innerHTML = '<div class="' + NS + '-empty">正在建立资源索引…</div>';
      this.renderInfo("正在建立资源索引…");
    }
    try {
      await this.ensureIndex(force);
      if (this.destroyed || reqId !== st.reqId) return;
      st.items = this.isFlat() ? this.buildFlatItems() : this.buildDirItems(st.dir);
      this.renderCrumbs();
      this.renderBody();
      this.renderFoot();
      this.renderInfo();
      this.loadStats();
      const paths = st.items
        .filter(function (it) {
          return it.kind === "file";
        })
        .map(function (it) {
          return it.path;
        });
      this.prefetchVersions(paths, VER_PREFETCH_MAX);
    } catch (e) {
      if (this.destroyed || reqId !== st.reqId) return;
      const b = this.body();
      if (b) b.innerHTML = '<div class="' + NS + '-empty">加载失败：' + esc(e.message || e) + "</div>";
      this.renderInfo("加载失败");
    }
  }

  async repaint() {
    const st = this.state;
    if (this.destroyed) return;
    await this.ensureIndex(false);
    if (this.destroyed) return;
    st.items = this.isFlat() ? this.buildFlatItems() : this.buildDirItems(st.dir);
    this.renderBody();
    this.renderFoot();
    this.renderInfo();
    this.loadStats();
  }

  renderChips() {
    const st = this.state;
    const chips = this.root.querySelectorAll("#" + NS + "-chips ." + NS + "-chip");
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i];
      const act = c.getAttribute("data-act");
      if (act === "type") c.classList.toggle(NS + "-chip--on", c.getAttribute("data-value") === st.type);
      else if (act === "onlyMissing") c.classList.toggle(NS + "-chip--on", !!st.onlyMissing);
      else if (act === "onlyHistory") c.classList.toggle(NS + "-chip--on", !!st.onlyHistory);
    }
  }

  renderCrumbs() {
    const st = this.state;
    const el = this.root.querySelector("#" + NS + "-crumbs");
    if (!el) return;
    if (this.isFlat()) {
      let label;
      if (st.search.trim()) label = "搜索：" + st.search.trim();
      else if (st.type !== "all") label = "分类：" + TYPE_LABEL[st.type];
      else if (st.onlyHistory) label = "有历史版本";
      else label = "仅未下载";
      el.innerHTML = '<span class="' + NS + '-crumb ' + NS + '-crumb--cur">' + esc(label) + "</span>";
      return;
    }
    const parts = segs(st.dir);
    let acc = "";
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? acc + "/" + parts[i] : parts[i];
      const cur = i === parts.length - 1;
      const label = i === 0 ? "assets" : parts[i];
      html +=
        '<button class="' + NS + '-crumb' + (cur ? " " + NS + "-crumb--cur" : "") + '" data-crumb="' + esc(acc) + '">' +
        esc(label) +
        "</button>";
      if (!cur) html += '<span class="' + NS + '-sep">/</span>';
    }
    el.innerHTML = html;
  }

  metaText(it) {
    if (it.kind === "dir") return it.virtual ? "含未下载资源" : "文件夹";
    const parts = [];
    if (it.size) parts.push(it.size);
    if (it.mtime) parts.push(it.mtime);
    return parts.join(" · ");
  }

  badgeHTML(it) {
    if (it.kind === "dir") {
      return (
        '<svg class="' + NS + '-dirico" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>'
      );
    }
    const ext = (extOf(it.name) || "?").toUpperCase().slice(0, 4);
    return '<span class="' + NS + '-ext ' + NS + '-ext--' + classify(it.name) + '">' + esc(ext) + "</span>";
  }

  thumbHTML(it) {
    if (it.kind === "file" && it.local !== false && isImageName(it.name)) {
      return (
        '<img class="' + NS + '-thumbimg" loading="lazy" decoding="async" alt="" src="' +
        esc(assetURL(it.path)) +
        '?style=thumb">'
      );
    }
    return this.badgeHTML(it);
  }

  checkHTML(it) {
    if (it.kind !== "file") return "";
    const sel = this.state.selected.has(it.path);
    return (
      '<label class="' + NS + '-check" title="选择"><input type="checkbox" data-select="' +
      esc(it.path) + '"' + (sel ? " checked" : "") + "></label>"
    );
  }

  metaHTML(it) {
    const n = it.kind === "file" ? this.verShow(it.path) : 0;
    return (
      '<span class="' + NS + '-metatext">' + esc(this.metaText(it)) + "</span>" +
      '<span class="' + NS + '-histpill' + (n ? "" : " fn__none") + '">历史 ' + (n || 0) + " 版</span>" +
      (it.kind === "dir" ? "" : '<span class="' + NS + '-badge ' + NS + '-badge--broken fn__none">已丢失</span>')
    );
  }

  tileHTML(it) {
    const sel = this.state.selected.has(it.path);
    const missing = it.kind === "file" && it.local === false;
    return (
      '<div class="' + NS + '-tile' + (sel ? " " + NS + "--sel" : "") + (missing ? " " + NS + "--missing" : "") +
      '" data-path="' + esc(it.path) + '" data-kind="' + it.kind + '">' +
      this.checkHTML(it) +
      '<div class="' + NS + '-thumb">' + this.thumbHTML(it) +
      '<button class="' + NS + '-dlbtn ' + NS + '-dlbtn--tile' + (missing ? "" : " fn__none") +
      '" data-act="download">下载</button>' +
      "</div>" +
      '<div class="' + NS + '-name" title="' + esc(it.name) + '">' + esc(it.name) + "</div>" +
      '<div class="' + NS + '-meta">' + this.metaHTML(it) + "</div>" +
      "</div>"
    );
  }

  rowHTML(it) {
    const sel = this.state.selected.has(it.path);
    const missing = it.kind === "file" && it.local === false;
    return (
      '<div class="' + NS + '-row' + (sel ? " " + NS + "--sel" : "") + (missing ? " " + NS + "--missing" : "") +
      '" data-path="' + esc(it.path) + '" data-kind="' + it.kind + '">' +
      this.checkHTML(it) +
      '<div class="' + NS + '-rowico">' + this.thumbHTML(it) + "</div>" +
      '<div class="' + NS + '-rowmain">' +
      '<div class="' + NS + '-name" title="' + esc(it.name) + '">' + esc(it.name) + "</div>" +
      '<div class="' + NS + '-meta">' + this.metaHTML(it) + "</div>" +
      "</div>" +
      '<button class="' + NS + '-dlbtn' + (missing ? "" : " fn__none") + '" data-act="download">下载</button>' +
      "</div>"
    );
  }

  renderBody() {
    const st = this.state;
    const body = this.body();
    if (!body) return;
    const items = st.items || [];
    const shown = items.slice(0, st.limit);
    this._nodes = new Map();

    if (!shown.length) {
      let msg = "此文件夹为空";
      if (st.search.trim()) msg = "未找到匹配 “" + st.search.trim() + "” 的资源";
      else if (st.type !== "all") msg = "没有 " + TYPE_LABEL[st.type] + " 类型的资源";
      else if (st.onlyHistory) msg = "当前列表中没有带历史版本的资源";
      else if (st.onlyMissing) msg = "没有未下载的资源 🎉";
      body.className = NS + "-body";
      body.innerHTML = '<div class="' + NS + '-empty">' + esc(msg) + "</div>";
      return;
    }

    const grid = st.view === "grid";
    body.className = NS + "-body " + (grid ? NS + "-body--grid" : NS + "-body--list");
    let html = shown
      .map((it) => (grid ? this.tileHTML(it) : this.rowHTML(it)))
      .join("");
    if (items.length > st.limit) {
      html +=
        '<button class="' + NS + '-more" data-act="more">加载更多（还有 ' + (items.length - st.limit) + " 项）</button>";
    }
    body.innerHTML = html;

    const nodes = body.querySelectorAll("[data-path]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      this._nodes.set(el.getAttribute("data-path"), {
        card: el,
        metatext: el.querySelector("." + NS + "-metatext"),
        histpill: el.querySelector("." + NS + "-histpill"),
        badge: el.querySelector("." + NS + "-badge"),
        dl: el.querySelector("." + NS + "-dlbtn"),
      });
    }
  }

  renderInfo(override) {
    if (!this.root) return;
    const info = this.root.querySelector("#" + NS + "-info");
    if (!info) return;
    if (override) {
      info.textContent = override;
      return;
    }
    const st = this.state;
    const items = st.items || [];
    let files = 0;
    let missing = 0;
    let hist = 0;
    items.forEach((i) => {
      if (i.kind !== "file") return;
      files++;
      if (i.local === false) missing++;
      if (this.verShow(i.path)) hist++;
    });
    const dirs = items.length - files;
    let mode;
    if (st.search.trim()) mode = "搜索 “" + st.search.trim() + "”";
    else if (st.type !== "all") mode = "分类 " + TYPE_LABEL[st.type];
    else mode = "浏览 " + st.dir;
    if (st.onlyMissing) mode += " · 仅未下载";
    if (st.onlyHistory) mode += " · 有历史版本";
    let text = mode + " · 共 " + items.length + " 项";
    if (dirs) text += "，文件夹 " + dirs;
    if (files) text += "，文件 " + files;
    if (missing) text += "，待下载 " + missing;
    if (hist) text += "，有历史 " + hist;
    text += " · 本地 " + st.local.length + " 个 · " + (st.view === "grid" ? "缩略图" : "列表");
    info.textContent = text;
  }

  renderFoot() {
    if (!this.root) return;
    const el = this.root.querySelector("#" + NS + "-selcount");
    if (el && this.state) el.textContent = "已选 " + this.state.selected.size;
  }

  /* ---------------- 元信息延迟加载 ---------------- */
  async loadStats() {
    const st = this.state;
    if (!st || this.destroyed) return;
    const token = (st.statToken = st.statToken + 1);
    const slice = st.items.slice(0, Math.min(st.limit, STAT_MAX));
    const localQ = [];
    const missQ = [];
    slice.forEach(function (it) {
      if (it.kind !== "file" || it.statDone) return;
      if (it.local === false) missQ.push(it.path);
      else localQ.push(it.path);
    });
    if (missQ.length > MISS_STAT_MAX) missQ.length = MISS_STAT_MAX;
    const queue = localQ.concat(missQ);
    if (!queue.length) return;

    let idx = 0;
    const runner = async () => {
      while (idx < queue.length) {
        if (this.destroyed || token !== st.statToken) return;
        const p = queue[idx++];
        let data = null;
        try {
          data = await api("/api/asset/statAsset", { path: p });
        } catch (e) {
          data = null;
        }
        if (this.destroyed || token !== st.statToken) return;
        const it = this.findItem(p);
        if (!it) continue;
        it.statDone = true;
        if (data) {
          it.size = data.hSize || sizeText(data.size);
          it.sizeBytes = data.size;
          it.mtime = dateText(data.updated);
          it.broken = false;
          it.local = data.downloaded !== false;
        } else if (it.local === false) {
          it.broken = true;
        }
        this.paintMeta(p);
      }
    };
    const workers = [];
    for (let i = 0; i < 3; i++) workers.push(runner());
    await Promise.all(workers);
  }

  paintMeta(p) {
    const it = this.findItem(p);
    const nodes = this._nodes ? this._nodes.get(p) : null;
    if (!it || !nodes) return;
    if (nodes.metatext) nodes.metatext.textContent = this.metaText(it);
    if (nodes.histpill) {
      const n = it.kind === "file" ? this.verShow(it.path) : 0;
      if (n) {
        nodes.histpill.textContent = "历史 " + n + " 版";
        nodes.histpill.className = NS + "-histpill";
      } else {
        nodes.histpill.textContent = "";
        nodes.histpill.className = NS + "-histpill fn__none";
      }
    }
    if (nodes.badge) {
      if (it.local === false && it.broken) {
        nodes.badge.textContent = "已丢失";
        nodes.badge.className = NS + "-badge " + NS + "-badge--broken";
      } else {
        nodes.badge.textContent = "";
        nodes.badge.className = NS + "-badge " + NS + "-badge--broken fn__none";
      }
    }
    if (nodes.dl) {
      const isTile = nodes.card && nodes.card.classList.contains(NS + "-tile");
      const show = it.kind === "file" && it.local === false && !it.broken;
      nodes.dl.className = NS + "-dlbtn" + (isTile ? " " + NS + "-dlbtn--tile" : "") + (show ? "" : " fn__none");
    }
  }

  onImgError(ev) {
    const t = ev.target;
    if (!t || t.tagName !== "IMG") return;
    const card = t.closest ? t.closest("[data-path]") : null;
    if (!card) return;
    const path = card.getAttribute("data-path");
    const it = this.findItem(path);
    const box = card.querySelector("." + NS + "-thumb");
    if (box) box.insertAdjacentHTML("afterbegin", this.badgeHTML(it || { name: basename(path), kind: "file" }));
    try {
      t.remove();
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------- 事件分发 ---------------- */
  onClick(ev) {
    if (this.destroyed) return;
    const el = ev.target;
    if (!el || !el.closest) return;

    const actEl = el.closest("[data-act]");
    if (actEl) {
      ev.preventDefault();
      ev.stopPropagation();
      this.handleAction(actEl.getAttribute("data-act"), actEl);
      return;
    }

    if (el.closest("." + NS + "-check")) return;

    const crumb = el.closest("[data-crumb]");
    if (crumb) {
      this.gotoDir(crumb.getAttribute("data-crumb"));
      return;
    }

    const card = el.closest("[data-path]");
    if (card) {
      const it = this.findItem(card.getAttribute("data-path"));
      if (it) this.openItem(it);
    }
  }

  onChange(ev) {
    const t = ev.target;
    if (!t || !t.getAttribute || this.destroyed) return;
    const p = t.getAttribute("data-select");
    if (p === null) return;
    if (t.checked) this.state.selected.add(p);
    else this.state.selected.delete(p);
    const card = t.closest("[data-path]");
    if (card) card.classList.toggle(NS + "--sel", !!t.checked);
    this.renderFoot();
  }

  async handleAction(act, el) {
    const st = this.state;
    if (!st) return;
    switch (act) {
      case "up":
        if (!this.isFlat() && st.dir !== ASSETS_REL) this.gotoDir(dirname(st.dir));
        break;
      case "home":
        this.gotoHome();
        break;
      case "refresh":
        this.refresh(true);
        break;
      case "settings":
        this.plugin.openSettings(this);
        break;
      case "view":
        st.view = st.view === "grid" ? "list" : "grid";
        this.renderBar();
        this.renderBody();
        this.renderInfo();
        this.loadStats();
        break;
      case "more":
        st.limit += PAGE_SIZE;
        this.renderBody();
        this.loadStats();
        this.prefetchVersions(
          st.items.slice(Math.max(0, st.limit - PAGE_SIZE), st.limit).map(function (it) {
            return it.path;
          }),
          VER_PREFETCH_MAX
        );
        break;
      case "type":
        st.type = el.getAttribute("data-value") || "all";
        st.onlyMissing = false;
        st.onlyHistory = false;
        st.search = "";
        this.clearSearchInput();
        this.renderChips();
        this.refresh(false);
        break;
      case "onlyMissing":
        st.onlyMissing = !st.onlyMissing;
        if (st.onlyMissing) st.onlyHistory = false;
        this.renderChips();
        this.refresh(false);
        break;
      case "onlyHistory":
        st.onlyHistory = !st.onlyHistory;
        if (st.onlyHistory) {
          st.onlyMissing = false;
          this.renderInfo("正在查询数据快照版本…");
          const paths = (st.items || [])
            .filter(function (it) {
              return it.kind === "file";
            })
            .map(function (it) {
              return it.path;
            });
          await this.prefetchVersions(paths, VER_FILTER_MAX);
        }
        this.renderChips();
        this.refresh(false);
        break;
      case "selectAll":
        this.toggleSelectAll();
        break;
      case "batch-download":
        this.batchDownload();
        break;
      case "batch-copy":
        this.batchCopy();
        break;
      case "batch-delete":
        this.batchDelete();
        break;
      case "download":
        this.downloadFromUI(this.pathOf(el));
        break;
      case "closeoverlay":
        this.closeOverlay();
        break;
      case "zoomreset":
        this.zoomReset();
        break;
      case "moreitem":
        {
          const p = this._previewPath;
          this.closeOverlay();
          const item = this.findItem(p);
          if (item) this.openSheet(item);
        }
        break;
      case "preview":
        this.preview(this.itemOrSheet(el));
        break;
      case "openfile":
        this.openFile(this.itemOrSheet(el));
        break;
      case "saveas":
        this.saveAs(this.itemOrSheet(el));
        break;
      case "history":
        this.openVersions(this.itemOrSheet(el));
        break;
      case "copypath":
        this.copyPath(this.pathOf(el) || this._sheetPath || "");
        break;
      case "copyref":
        this.copyRef(this.itemOrSheet(el));
        break;
      case "openref":
        this.openRef(this.itemOrSheet(el));
        break;
      case "deletefile":
        this.deleteOne(this.itemOrSheet(el));
        break;
      default:
        break;
    }
  }

  pathOf(el) {
    const card = el && el.closest ? el.closest("[data-path]") : null;
    if (card) return card.getAttribute("data-path");
    return this._sheetPath || "";
  }

  itemOrSheet(el) {
    return this.findItem(this.pathOf(el)) || this.sheetItem();
  }

  sheetItem() {
    return this.findItem(this._sheetPath) || { path: this._sheetPath, name: basename(this._sheetPath), kind: "file" };
  }

  clearSearchInput() {
    if (!this.root) return;
    const si = this.root.querySelector("#" + NS + "-search");
    if (si) si.value = "";
  }

  gotoDir(rel) {
    const st = this.state;
    if (!st || this.destroyed) return;
    st.dir = rel;
    st.type = "all";
    st.search = "";
    st.onlyMissing = false;
    st.onlyHistory = false;
    st.selected.clear();
    this.clearSearchInput();
    this.renderChips();
    this.refresh(false);
  }

  gotoHome() {
    this.gotoDir(this.plugin.homePath || ASSETS_REL);
  }

  /** 目录：进入；文件：一律打开操作菜单 */
  openItem(it) {
    if (it.kind === "dir") {
      this.gotoDir(it.path);
      return;
    }
    this.openSheet(it);
  }

  toggleSelectAll() {
    const st = this.state;
    if (!st) return;
    const files = (st.items || []).filter(function (it) {
      return it.kind === "file";
    });
    const allSel =
      files.length > 0 &&
      files.every(function (it) {
        return st.selected.has(it.path);
      });
    if (allSel) st.selected.clear();
    else files.forEach(function (it) { st.selected.add(it.path); });
    this.renderBody();
    this.renderFoot();
  }

  selectedItems() {
    const st = this.state;
    if (!st) return [];
    return (st.items || []).filter(function (it) {
      return st.selected.has(it.path);
    });
  }

  /* ---------------- 覆盖层 ---------------- */
  closeOverlay() {
    this._objUrls.forEach(function (u) {
      try {
        URL.revokeObjectURL(u);
      } catch (e) {
        /* ignore */
      }
    });
    this._objUrls = [];
    if (this._overlay) {
      try {
        this._overlay.remove();
      } catch (e) {
        /* ignore */
      }
      this._overlay = null;
    }
  }

  openSheet(it) {
    this.closeOverlay();
    const isImg = isImageName(it.name);
    const canOpen = it.local !== false;
    const hasRef = !!(it.remote && it.remote.blockId);
    const vcount = it.kind === "file" ? this.verShow(it.path) : 0;
    const rows = [];
    if (it.local === false) rows.push('<button class="' + NS + '-sheetbtn ' + NS + '-sheetbtn--primary" data-act="download">⬇ 下载到本地</button>');
    if (canOpen && isImg) rows.push('<button class="' + NS + '-sheetbtn ' + NS + '-sheetbtn--primary" data-act="preview">🔍 预览</button>');
    if (canOpen) rows.push('<button class="' + NS + '-sheetbtn" data-act="saveas">📥 另存为（保存到本机）</button>');
    if (canOpen) rows.push('<button class="' + NS + '-sheetbtn" data-act="openfile">↗ 用其它应用打开</button>');
    rows.push('<button class="' + NS + '-sheetbtn" data-act="copypath">📋 复制资源路径</button>');
    rows.push('<button class="' + NS + '-sheetbtn" data-act="copyref">📎 复制为引用</button>');
    if (hasRef) rows.push('<button class="' + NS + '-sheetbtn" data-act="openref">🔗 打开引用处</button>');
    // 只有 1 个内容版本（或已知不足 2 个）的文件不显示历史版本
    if (it.kind === "file" && this.showHistoryEntry(it.path)) {
      rows.push(
        '<button class="' + NS + '-sheetbtn" data-act="history">🕘 历史版本' + (vcount ? "（" + vcount + "）" : "") + "</button>"
      );
    }
    if (it.local !== false) rows.push('<button class="' + NS + '-sheetbtn ' + NS + '-sheetbtn--danger" data-act="deletefile">🗑 删除</button>');
    rows.push('<button class="' + NS + '-sheetbtn" data-act="closeoverlay">取消</button>');

    const wrap = document.createElement("div");
    wrap.className = NS + "-overlay";
    wrap.innerHTML =
      '<div class="' + NS + '-mask" data-act="closeoverlay"></div>' +
      '<div class="' + NS + '-sheet">' +
      '<div class="' + NS + '-sheet__title">' + esc(it.name) + "</div>" +
      '<div class="' + NS + '-sheet__sub">' + esc(it.path) + "</div>" +
      rows.join("") +
      "</div>";
    this.root.appendChild(wrap);
    this._overlay = wrap;
    this._sheetPath = it.path;
  }

  preview(it) {
    if (!it || it.local === false) {
      showMessage("该文件尚未下载到本地，请先下载", 4000);
      return;
    }
    this.closeOverlay();
    this._previewPath = it.path;
    const url = assetURL(it.path);
    const wrap = document.createElement("div");
    wrap.className = NS + "-overlay";
    wrap.innerHTML =
      '<div class="' + NS + '-mask" data-act="closeoverlay"></div>' +
      '<div class="' + NS + '-lightbox">' +
      '<div class="' + NS + '-lightbox__stage"><img src="' + esc(url) + '" alt=""></div>' +
      '<div class="' + NS + '-lightbox__bar">' +
      '<span class="' + NS + '-lightbox__name">' + esc(it.name) + "</span>" +
      '<button class="' + NS + '-btn" data-act="moreitem">更多</button>' +
      '<button class="' + NS + '-btn" data-act="zoomreset">还原</button>' +
      '<button class="' + NS + '-btn" data-act="closeoverlay">关闭</button>' +
      "</div></div>";
    this.root.appendChild(wrap);
    this._overlay = wrap;
    this.bindLightbox(wrap);
  }

  bindLightbox(wrap) {
    const self = this;
    const stage = wrap.querySelector("." + NS + "-lightbox__stage");
    const img = wrap.querySelector("." + NS + "-lightbox__stage img");
    if (!stage || !img) return;

    const st = {
      scale: 1,
      tx: 0,
      ty: 0,
      startDist: 0,
      startScale: 1,
      startTx: 0,
      startTy: 0,
      midX: 0,
      midY: 0,
      panning: false,
      startX: 0,
      startY: 0,
      moved: false,
      lastTap: 0,
      tapTimer: 0,
    };

    const apply = function () {
      img.style.transform = "translate(" + st.tx + "px," + st.ty + "px) scale(" + st.scale + ")";
    };
    const reset = function () {
      st.scale = 1;
      st.tx = 0;
      st.ty = 0;
      apply();
    };
    wrap.__amReset = reset;

    const clampScale = function (s) {
      return Math.min(8, Math.max(1, s));
    };
    const dist = function (a, b) {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const offset = function (cx, cy) {
      const r = stage.getBoundingClientRect();
      return { x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2) };
    };
    const zoomAt = function (targetScale, ox, oy) {
      const s = clampScale(targetScale);
      const ratio = s / st.scale;
      st.tx = ox - ratio * (ox - st.tx);
      st.ty = oy - ratio * (oy - st.ty);
      st.scale = s;
      apply();
    };

    stage.addEventListener(
      "touchstart",
      function (e) {
        st.moved = false;
        if (e.touches.length === 2) {
          st.startDist = dist(e.touches[0], e.touches[1]);
          st.startScale = st.scale;
          st.startTx = st.tx;
          st.startTy = st.ty;
          const o = offset(
            (e.touches[0].clientX + e.touches[1].clientX) / 2,
            (e.touches[0].clientY + e.touches[1].clientY) / 2
          );
          st.midX = o.x;
          st.midY = o.y;
        } else if (e.touches.length === 1) {
          st.panning = true;
          st.startX = e.touches[0].clientX;
          st.startY = e.touches[0].clientY;
          st.startTx = st.tx;
          st.startTy = st.ty;
        }
      },
      { passive: true }
    );

    stage.addEventListener(
      "touchmove",
      function (e) {
        if (e.touches.length === 2 && st.startDist > 0) {
          e.preventDefault();
          st.moved = true;
          const d = dist(e.touches[0], e.touches[1]);
          const s = clampScale(st.startScale * (d / st.startDist));
          const ratio = s / st.startScale;
          st.tx = st.midX - ratio * (st.midX - st.startTx);
          st.ty = st.midY - ratio * (st.midY - st.startTy);
          st.scale = s;
          apply();
        } else if (e.touches.length === 1 && st.panning) {
          const dx = e.touches[0].clientX - st.startX;
          const dy = e.touches[0].clientY - st.startY;
          if (st.scale > 1) e.preventDefault();
          if (Math.abs(dx) > 6 || Math.abs(dy) > 6) st.moved = true;
          st.tx = st.startTx + dx;
          st.ty = st.startTy + dy;
          apply();
        }
      },
      { passive: false }
    );

    stage.addEventListener("touchend", function (e) {
      if (e.touches.length === 1) {
        st.startDist = 0;
        st.panning = true;
        st.startX = e.touches[0].clientX;
        st.startY = e.touches[0].clientY;
        st.startTx = st.tx;
        st.startTy = st.ty;
        return;
      }
      if (e.touches.length > 0) return;
      st.panning = false;
      st.startDist = 0;
      if (st.scale <= 1.02) reset();
      if (st.moved) return;
      const now = Date.now();
      if (now - st.lastTap < 300) {
        st.lastTap = 0;
        if (st.tapTimer) {
          window.clearTimeout(st.tapTimer);
          st.tapTimer = 0;
        }
        const t = e.changedTouches && e.changedTouches[0];
        if (st.scale > 1.02) {
          reset();
        } else if (t) {
          const o = offset(t.clientX, t.clientY);
          zoomAt(2.5, o.x, o.y);
        }
        return;
      }
      st.lastTap = now;
      if (st.scale <= 1.02) {
        if (st.tapTimer) window.clearTimeout(st.tapTimer);
        st.tapTimer = window.setTimeout(function () {
          st.tapTimer = 0;
          if (st.scale <= 1.02) self.closeOverlay();
        }, 320);
      }
    });

    stage.addEventListener("dblclick", function (e) {
      const o = offset(e.clientX, e.clientY);
      if (st.scale > 1.02) reset();
      else zoomAt(2.5, o.x, o.y);
    });
    stage.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        const o = offset(e.clientX, e.clientY);
        zoomAt(st.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), o.x, o.y);
      },
      { passive: false }
    );
  }

  zoomReset() {
    if (this._overlay && typeof this._overlay.__amReset === "function") {
      this._overlay.__amReset();
    }
  }

  /* ---------------- 打开 / 另存为 ----------------
   * 照搬思源自身实现（app/src/protyle/util/compatibility.ts 的 saveExportFile）：
   *   移动端用 JSAndroid/JSHarmony/webkit 的 saveExportFile(V2) 桥；
   *   其它环境用 window.open(同源 URL + "?download=true")。
   *   不用 exportByDefault（它会把地址交给系统浏览器，被内核跨站校验拒绝）。
   */
  isAndroidLike() {
    try {
      return !!(window.JSAndroid || window.JSHarmony);
    } catch (e) {
      return false;
    }
  }

  isIOSApp() {
    try {
      return !!(window.webkit && window.webkit.messageHandlers);
    } catch (e) {
      return false;
    }
  }

  /** 用系统默认应用打开（Android/HarmonyOS 传相对路径；iOS 传完整 URL） */
  openFile(it) {
    if (!it || it.local === false) {
      showMessage("该文件尚未下载到本地，请先下载", 4000);
      return;
    }
    this.closeOverlay();
    const rel = it.path;
    if (this.isAndroidLike()) {
      try {
        if (window.JSAndroid && typeof window.JSAndroid.openExternal === "function") {
          window.JSAndroid.openExternal(rel);
          return;
        }
        if (window.JSHarmony && typeof window.JSHarmony.openExternal === "function") {
          window.JSHarmony.openExternal(rel);
          return;
        }
      } catch (e) {
        console.log(TAG + " openExternal 失败：" + ((e && e.message) || e));
      }
    }
    if (this.isIOSApp() && window.webkit.messageHandlers.openLink) {
      try {
        const rest = rel.replace(/^assets\//, "");
        window.webkit.messageHandlers.openLink.postMessage(originURL() + "/assets/" + encodeURIComponent(rest));
        return;
      } catch (e) {
        console.log(TAG + " openLink 失败：" + ((e && e.message) || e));
      }
    }
    if (!this.isMobile && typeof openTab === "function") {
      try {
        openTab({ app: this.plugin.app, asset: { path: rel } });
        return;
      } catch (e) {
        /* 退回到新窗口打开 */
      }
    }
    try {
      const w = window.open(absURL(rel), "_blank");
      if (!w) showMessage("无法打开，可先复制资源路径", 5000);
    } catch (e) {
      showMessage("打开失败：" + (e.message || e), 5000);
    }
  }

  /** 移动端“另存为”：调用原生 saveExportFile(V2)，返回 {status} 或 null（无可用桥） */
  async mobileSaveExport(uri) {
    const plugin = this.plugin;
    const wait = (caller) =>
      new Promise((resolve) => {
        const requestID = genId();
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          plugin._saveExportPending.delete(requestID);
          resolve(result || { status: "error" });
        };
        plugin._saveExportPending.set(requestID, finish);
        try {
          caller(requestID);
        } catch (e) {
          finish({ status: "error", message: String(e) });
          return;
        }
        window.setTimeout(function () {
          finish({ status: "success" });
        }, SAVE_TIMEOUT);
      });
    try {
      if (window.JSAndroid && typeof window.JSAndroid.saveExportFileV2 === "function") {
        return await wait((id) => window.JSAndroid.saveExportFileV2(uri, id));
      }
      if (window.JSAndroid && typeof window.JSAndroid.saveExportFile === "function") {
        window.JSAndroid.saveExportFile(uri);
        return { status: "success" };
      }
      if (window.JSHarmony && typeof window.JSHarmony.saveExportFileV2 === "function") {
        return await wait((id) => window.JSHarmony.saveExportFileV2(uri, id));
      }
      if (window.JSHarmony && typeof window.JSHarmony.saveExportFile === "function") {
        window.JSHarmony.saveExportFile(uri);
        return { status: "success" };
      }
      if (this.isIOSApp()) {
        if (window.webkit.messageHandlers.saveExportFileV2) {
          return await wait((id) => window.webkit.messageHandlers.saveExportFileV2.postMessage({ uri: uri, requestID: id }));
        }
        if (window.webkit.messageHandlers.saveExportFile) {
          window.webkit.messageHandlers.saveExportFile.postMessage(uri);
          return { status: "success" };
        }
      }
    } catch (e) {
      console.log(TAG + " 另存为失败：" + ((e && e.message) || e));
      return { status: "error", message: String((e && e.message) || e) };
    }
    return null;
  }

  /** 非移动端：思源自己的做法（同源 + download=true 触发下载） */
  webviewSave(rel) {
    const url = assetURL(rel) + "?download=true";
    try {
      const w = window.open(url);
      if (w) return true;
    } catch (e) {
      /* ignore */
    }
    try {
      const a = document.createElement("a");
      a.href = url;
      a.setAttribute("download", basename(rel));
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 另存为：移动端走原生 saveExportFile，其它环境走同源下载 */
  async saveAs(it) {
    if (!it || it.local === false) {
      showMessage("该文件尚未下载到本地，请先下载", 4000);
      return;
    }
    this.closeOverlay();
    const name = it.name || basename(it.path);
    const res = await this.mobileSaveExport(it.path);
    if (res) {
      if (res.status === "success") showMessage("已保存：" + name, 4000);
      else if (res.status === "canceled") showMessage("已取消保存", 3000);
      else showMessage("保存失败，请重试，或用「用其它应用打开」后在该应用里另存为", 6000);
      return;
    }
    if (this.webviewSave(it.path)) {
      showMessage("已开始下载：" + name, 4000);
      return;
    }
    showMessage("当前环境不支持另存为，可先复制资源路径", 5000);
  }

  async copyPath(p) {
    if (!p) return;
    const ok = await copyText(p);
    showMessage(ok ? "已复制：" + p : "复制失败，请手动复制：" + p, ok ? 3000 : 6000);
  }

  /** 复制为引用：图片 -> ![名称](assets/xxx)，其它 -> [名称](assets/xxx)，可直接粘贴到文档 */
  async copyRef(it) {
    if (!it || it.kind !== "file") return;
    this.closeOverlay();
    const name = it.name || basename(it.path);
    const md = isImageName(it.path) ? "![" + name + "](" + it.path + ")" : "[" + name + "](" + it.path + ")";
    const ok = await copyText(md);
    showMessage(ok ? "已复制引用：" + md : "复制失败：" + md, ok ? 5000 : 7000);
  }

  openRef(it) {
    this.closeOverlay();
    const blockId = it && it.remote && it.remote.blockId ? it.remote.blockId : "";
    if (!blockId) return;
    try {
      const actions = [Constants.CB_GET_HL, Constants.CB_GET_ROOTSCROLL].filter(function (a) {
        return a !== undefined && a !== null;
      });
      if (this.isMobile && typeof openMobileFileById === "function") {
        openMobileFileById(this.plugin.app, blockId, actions);
      } else if (typeof openTab === "function") {
        openTab({ app: this.plugin.app, doc: { id: blockId } });
      }
    } catch (e) {
      showMessage("无法打开引用处：" + (e.message || e), 5000);
    }
  }

  /* ---------------- 历史版本（数据快照）：查看 / 还原 ---------------- */
  async openVersions(it) {
    this.closeOverlay();
    if (!it || it.kind !== "file") return;
    let versions = this.verCount(it.path) === null ? null : this.plugin._verCache.get(it.path).list;
    if (!versions) {
      showMessage("正在查询数据快照…", 2000);
      versions = await this.versionsOf(it.path, true);
    }
    if (!versions || versions.length < VER_MIN_SHOW) {
      showMessage("该文件只有 1 个内容版本（即当前内容），没有可回溯的历史版本", 5000);
      return;
    }

    const rowsHtml = versions
      .map(function (v, i) {
        return (
          '<div class="' + NS + '-histitem">' +
          '<div class="' + NS + '-histitem__main">' +
          '<div class="' + NS + '-histitem__time">' + esc(dateTimeText(v.updated) || "未知时间") + "</div>" +
          '<div class="' + NS + '-histitem__op">' + esc(v.hSize || "") +
          (v.snapshotID ? " · 快照 " + esc(String(v.snapshotID).slice(0, 8)) : "") + "</div>" +
          "</div>" +
          '<button class="' + NS + '-btn" data-hact="preview" data-hi="' + i + '">预览</button>' +
          '<button class="' + NS + '-btn ' + NS + '-btn--danger" data-hact="rollback" data-hi="' + i + '">还原</button>' +
          "</div>"
        );
      })
      .join("");

    const dialog = new Dialog({
      title: "历史版本 · " + it.name,
      content:
        '<div class="' + NS + '-settings">' +
        '<div class="' + NS + '-settings__desc">来自<strong>数据快照</strong>，共 ' + versions.length +
        " 个内容版本（按文件时间倒序；同一内容只计一次）。还原会按快照里记录的路径写回工作区。</div>" +
        '<div class="' + NS + '-histview fn__none"></div>' +
        '<div class="' + NS + '-histlist">' + rowsHtml + "</div>" +
        '<div class="' + NS + '-settings__foot">' +
        '<button class="b3-button b3-button--cancel" id="' + NS + '-hist-close">关闭</button>' +
        "</div></div>",
      width: this.isMobile ? "94vw" : "min(720px, 88vw)",
      height: "min(76vh, 640px)",
    });

    const self = this;
    const closeBtn = dialog.element.querySelector("#" + NS + "-hist-close");
    if (closeBtn) closeBtn.addEventListener("click", () => dialog.destroy());
    dialog.element.addEventListener("click", async function (ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest("[data-hact]") : null;
      if (!btn) return;
      const v = versions[Number(btn.getAttribute("data-hi"))];
      if (!v) return;
      const act = btn.getAttribute("data-hact");
      if (act === "preview") {
        const view = dialog.element.querySelector("." + NS + "-histview");
        if (!view) return;
        view.classList.remove("fn__none");
        view.innerHTML = '<div class="' + NS + '-settings__desc">正在读取快照文件…</div>';
        try {
          const resp = await fetch("/api/repo/getRepoFile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: v.fileID }),
          });
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          self._objUrls.push(url);
          const name = basename(v.path) || it.name;
          const img = isImageName(v.path) ? '<img src="' + esc(url) + '" alt="">' : "";
          view.innerHTML =
            img +
            '<div class="' + NS + '-settings__desc">' + esc(name) + " · " + esc(sizeText(blob.size)) +
            '　<a class="b3-button b3-button--outline" download="' + esc(name) + '" href="' + esc(url) +
            '">下载该版本</a></div>';
        } catch (e) {
          view.innerHTML =
            '<div class="' + NS + '-settings__desc">读取快照文件失败：' + esc((e && e.message) || e) + "</div>";
        }
        return;
      }
      if (act === "rollback") {
        const run = async function () {
          try {
            await api("/api/repo/rollbackRepoSnapshotFile", { id: v.fileID });
            showMessage("已从数据快照还原：" + basename(v.path), 5000);
            self.plugin._indexCache = null;
            self.plugin._verCache.clear();
            dialog.destroy();
            await self.refresh(true);
          } catch (e) {
            showMessage("还原失败：" + ((e && e.message) || e), 6000);
          }
        };
        if (typeof confirm === "function") {
          confirm(
            "还原历史版本",
            "将从数据快照还原 " + (dateTimeText(v.updated) || "该版本") + " 的 " + basename(v.path) +
              "（按快照内路径写回，会覆盖当前文件），确定继续？",
            run
          );
        } else {
          run();
        }
        return;
      }
    });
  }

  /* ---------------- 下载 ---------------- */
  async fetchAsset(p) {
    const url = assetURL(p);
    const hasAbort = typeof AbortController !== "undefined";
    const controller = hasAbort ? new AbortController() : null;
    const init = { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" };
    if (controller) init.signal = controller.signal;
    let resp = null;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      return { ok: false, status: 0, msg: e && e.message ? e.message : String(e) };
    }
    const status = resp.status;
    if (resp.ok || status === 206) {
      if (controller) {
        try {
          controller.abort();
        } catch (e) {
          /* ignore */
        }
      } else {
        try {
          if (resp.body && resp.body.cancel) resp.body.cancel();
        } catch (e) {
          /* ignore */
        }
      }
      return { ok: true, status: status };
    }
    let msg = "";
    try {
      msg = await resp.text();
    } catch (e) {
      msg = "";
    }
    if (msg && msg.length > 300) msg = msg.slice(0, 300);
    return { ok: false, status: status, msg: msg };
  }

  downloadErrMsg(res, p) {
    const name = basename(p);
    if (res.status === 404) return "无法下载 " + name + "：内核未找到该资源（云端也没有）。";
    if (res.status === 503) {
      return (
        "无法下载 " + name + "：资源按需下载不可用。" +
        (res.msg ? "内核提示：" + res.msg : "") +
        " 请确认已开启云端同步，并具备相应的订阅/功能特性。"
      );
    }
    if (res.status === 401 || res.status === 403) return "无法下载 " + name + "：鉴权失败。";
    if (res.status === 0) return "无法下载 " + name + "：网络错误" + (res.msg ? "（" + res.msg + "）" : "") + "。";
    return "下载失败 " + name + "（HTTP " + res.status + "）" + (res.msg ? "：" + res.msg : "");
  }

  afterDownloaded(p) {
    const st = this.state;
    if (!st || st.localSet.has(p)) return;
    st.localSet.add(p);
    st.local.push({ path: p, name: basename(p), updated: Math.floor(Date.now() / 1000) });
    st.dirs.add(dirname(p));
    st.notLocal = st.notLocal.filter(function (v) {
      return v.path !== p;
    });
  }

  async downloadFromUI(p) {
    const st = this.state;
    if (!p || !st || st.busy || this.destroyed) return;
    const it = this.findItem(p);
    if (it && it.local !== false) {
      showMessage("该文件已存在于本地", 3000);
      return;
    }
    st.busy = true;
    this.renderInfo("正在下载：" + basename(p));
    const res = await this.fetchAsset(p);
    st.busy = false;
    if (this.destroyed) return;
    if (res.ok) {
      this.afterDownloaded(p);
      st.selected.delete(p);
      this.closeOverlay();
      await this.repaint();
      showMessage("已下载：" + basename(p), 3000);
    } else {
      this.renderInfo();
      showMessage(this.downloadErrMsg(res, p), 8000);
    }
  }

  async batchDownload() {
    const st = this.state;
    if (!st || st.busy || this.destroyed) return;
    const sel = this.selectedItems().filter(function (it) {
      return it.kind === "file";
    });
    if (!sel.length) {
      showMessage("请先勾选要下载的资源（可点“仅未下载”筛选）", 4000);
      return;
    }
    const targets = sel.filter(function (it) {
      return it.local === false;
    });
    if (!targets.length) {
      showMessage("所选资源均已下载到本地", 4000);
      return;
    }
    st.busy = true;
    let done = 0;
    let okCount = 0;
    let firstErr = "";
    const total = targets.length;
    for (let i = 0; i < targets.length; i++) {
      if (this.destroyed) break;
      const p = targets[i].path;
      this.renderInfo("正在下载 " + (done + 1) + "/" + total + "：" + basename(p));
      const res = await this.fetchAsset(p);
      if (res.ok) {
        okCount++;
        this.afterDownloaded(p);
        st.selected.delete(p);
      } else if (!firstErr) {
        firstErr = this.downloadErrMsg(res, p);
      }
      done++;
    }
    st.busy = false;
    if (this.destroyed) return;
    await this.repaint();
    if (firstErr) showMessage("完成 " + okCount + "/" + total + "。首个错误：" + firstErr, 9000);
    else showMessage("已下载 " + okCount + " 个资源", 4000);
  }

  /* ---------------- 批量操作 ---------------- */
  async batchCopy() {
    const st = this.state;
    if (!st) return;
    let list = this.selectedItems();
    if (!list.length) list = (st.items || []).slice(0, st.limit);
    if (!list.length) {
      showMessage("没有可复制的项", 3000);
      return;
    }
    const text = list
      .map(function (it) {
        return it.path;
      })
      .join("\n");
    const ok = await copyText(text);
    showMessage(ok ? "已复制 " + list.length + " 条资源路径" : "复制失败", 4000);
  }

  async batchDelete() {
    const st = this.state;
    if (!st || st.busy || this.destroyed) return;
    const plugin = this.plugin;
    const sel = this.selectedItems().filter(function (it) {
      return it.kind === "file" && it.local !== false;
    });
    if (!sel.length) {
      showMessage("请先勾选要删除的本地资源", 4000);
      return;
    }
    const paths = sel.map(function (it) {
      return it.path;
    });
    const homeCount = paths.filter(function (p) {
      return plugin.isHomeFile(p);
    }).length;
    const extra = homeCount ? "其中 " + homeCount + " 个位于思源网盘目录（" + plugin.homePath + "）。" : "";
    const yes = await this.askConfirm(
      "删除资源",
      "将永久删除 " + paths.length + " 个资源文件（位于 data/assets 下）。" + extra +
        "若被文档引用，引用将失效。此操作不可撤销（可从数据快照还原），确定继续？",
      "删除"
    );
    if (!yes || this.destroyed) return;
    st.busy = true;
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < paths.length; i++) {
      if (this.destroyed) break;
      this.renderInfo("正在删除 " + (i + 1) + "/" + paths.length + "：" + basename(paths[i]));
      try {
        await plugin.removeFile("/data/" + paths[i], true);
        ok++;
        plugin._verCache.delete(paths[i]);
        this.removeLocal(paths[i]);
        st.selected.delete(paths[i]);
      } catch (e) {
        fail++;
      }
    }
    st.busy = false;
    if (this.destroyed) return;
    await this.repaint();
    showMessage("已删除 " + ok + " 个资源" + (fail ? "，失败 " + fail + " 个" : "") + "（可从数据快照还原）", 6000);
  }

  removeLocal(p) {
    const st = this.state;
    if (!st) return;
    st.deleted.add(p);
    st.localSet.delete(p);
    st.local = st.local.filter(function (f) {
      return f.path !== p;
    });
  }

  async deleteOne(it) {
    if (!it || it.kind !== "file" || it.local === false || this.destroyed) {
      showMessage("只能删除已下载到本地的资源", 4000);
      return;
    }
    const plugin = this.plugin;
    const isHome = plugin.isHomeFile(it.path);
    const yes = await this.askConfirm(
      "删除资源",
      (isHome ? "将永久删除思源网盘文件 " + it.path + "。" : "将永久删除资源文件 " + it.path + "。") +
        "若被文档引用，引用将失效。此操作不可撤销（可从数据快照还原），确定继续？",
      "删除"
    );
    if (!yes || this.destroyed) return;
    this.closeOverlay();
    const st = this.state;
    this.renderInfo("正在删除：" + it.name);
    try {
      await plugin.removeFile("/data/" + it.path, true);
      plugin._verCache.delete(it.path);
      this.removeLocal(it.path);
      st.selected.delete(it.path);
      await this.repaint();
      showMessage("已删除：" + it.name + "（可从数据快照还原）", 5000);
    } catch (e) {
      this.renderInfo();
      showMessage("删除失败：" + ((e && e.message) || e), 6000);
    }
  }

  askConfirm(title, message, okText) {
    const self = this;
    return new Promise(function (resolve) {
      const wrap = document.createElement("div");
      wrap.className = NS + "-overlay " + NS + "-overlay--top";
      wrap.innerHTML =
        '<div class="' + NS + '-mask"></div>' +
        '<div class="' + NS + '-modal">' +
        '<div class="' + NS + '-modal__title">' + esc(title) + "</div>" +
        '<div class="' + NS + '-modal__body">' + esc(message) + "</div>" +
        '<div class="' + NS + '-modal__foot">' +
        '<button class="' + NS + '-btn" data-x="0">取消</button>' +
        '<button class="' + NS + '-btn ' + NS + '-btn--danger" data-x="1">' + esc(okText || "确定") + "</button>" +
        "</div></div>";
      const done = function (v) {
        try {
          wrap.remove();
        } catch (e) {
          /* ignore */
        }
        resolve(v);
      };
      wrap.addEventListener("click", function (e) {
        const b = e.target.closest ? e.target.closest("[data-x]") : null;
        if (b) {
          done(b.getAttribute("data-x") === "1");
          return;
        }
        if (e.target.classList && e.target.classList.contains(NS + "-mask")) done(false);
      });
      self.root.appendChild(wrap);
    });
  }
}

/* ========================= 插件入口 ========================= */
module.exports = class AssetManager extends Plugin {
  onload() {
    this._dialog = null;
    this._dialogBrowser = null;
    this._dockBrowser = null;
    this._tabBrowser = null;
    this._browsers = [];
    this._indexCache = null;
    this._verCache = new Map();
    this._bypassGuard = false;
    this.homePath = ASSETS_REL;
    this.guardDelete = true;
    this.isMobile = String(getFrontend()).indexOf("mobile") >= 0;
    this.tabId = this.name + TAB_TYPE;

    this.loadData(CONFIG_FILE)
      .then((data) => {
        if (!data) return;
        if (typeof data.homePath === "string") this.homePath = normalizeHomePath(data.homePath);
        if (typeof data.guardDelete === "boolean") this.guardDelete = data.guardDelete;
        this._browsers.forEach(function (b) {
          if (!b.destroyed) b.renderHome();
        });
        console.log(TAG + " 配置已加载：网盘目录=" + this.homePath + "，禁止外部删除=" + (this.guardDelete ? "开" : "关"));
      })
      .catch(() => {
        /* 无配置时使用默认值 */
      });

    this.installSaveExportBridge();
    this.installFetchGuard();
    this.installXhrGuard();

    const plugin = this;
    if (!this.isMobile) {
      // 桌面端：只注册顶栏按钮，点击打开自定义页签（不注册侧边栏 Dock）
      try {
        this.addTopBar({
          icon: "iconImage",
          title: PLUGIN_TITLE,
          callback: () => {
            this.openNetdiskTab();
          },
        });
      } catch (e) {
        console.error(TAG + " addTopBar failed:", e);
      }
      try {
        this.addTab({
          type: TAB_TYPE,
          init(custom) {
            try {
              const el = (custom && custom.element) || this.element;
              if (!el) return;
              el.innerHTML = "";
              el.classList.add(NS + "-tab");
              plugin._tabBrowser = new AssetBrowser(plugin, el);
              plugin._tabBrowser.start();
            } catch (e) {
              console.error(TAG + " tab init failed:", e);
            }
          },
          destroy() {
            if (plugin._tabBrowser) {
              plugin._tabBrowser.destroy();
              plugin._tabBrowser = null;
            }
          },
        });
      } catch (e) {
        console.error(TAG + " addTab failed:", e);
      }
    } else {
      // 手机端：停靠栏面板（设置菜单「扩展」分组 / 底部导航），不使用页签
      try {
        this.addDock({
          config: {
            position: "RightBottom",
            size: { width: 360, height: 0 },
            icon: "iconImage",
            title: "浏览资源",
          },
          data: {},
          type: "assetManager",
          init(custom) {
            try {
              const host = document.createElement("div");
              host.className = NS + "-dock";
              custom.element.appendChild(host);
              plugin._dockBrowser = new AssetBrowser(plugin, host);
              plugin._browsers.push(plugin._dockBrowser);
              plugin._dockBrowser.start();
            } catch (e) {
              console.error(TAG + " dock init failed:", e);
            }
          },
          destroy() {
            if (plugin._dockBrowser) {
              plugin._dockBrowser.destroy();
              plugin._dockBrowser = null;
            }
          },
        });
      } catch (e) {
        console.error(TAG + " addDock failed:", e);
      }
    }

    if (typeof Setting === "function") {
      let homeInput = null;
      let guardSwitch = null;
      try {
        this.setting = new Setting({
          confirmCallback: () => {
            if (homeInput) this.setHome(homeInput.value, false);
            if (guardSwitch) this.setGuard(guardSwitch.checked, false);
            this.saveConfig();
          },
        });
        this.setting.addItem({
          title: "网盘目录",
          direction: "row",
          description: "点击 ⌂ 时进入的目录，例如 assets 或 assets/同步盘（仅支持 data/assets 及其子目录）",
          createActionElement: () => {
            homeInput = document.createElement("input");
            homeInput.className = "b3-text-field fn__block";
            homeInput.placeholder = "assets";
            homeInput.value = plugin.homePath;
            return homeInput;
          },
        });
        this.setting.addItem({
          title: "禁止外部删除",
          description: "思源本体或其它插件删除网盘目录内的文件时直接拒绝（网盘面板内的删除不受影响）",
          createActionElement: () => {
            guardSwitch = document.createElement("input");
            guardSwitch.type = "checkbox";
            guardSwitch.className = "b3-switch fn__flex-center";
            guardSwitch.checked = !!plugin.guardDelete;
            return guardSwitch;
          },
        });
      } catch (e) {
        console.error(TAG + " init setting failed:", e);
      }
    }
  }

  onDataChanged() {
    /* 避免保存配置时被思源自动禁用再启用插件（会销毁已打开的界面） */
  }

  onunload() {
    this.closeDialog();
    if (this._tabBrowser) {
      this._tabBrowser.destroy();
      this._tabBrowser = null;
    }
    if (this._dockBrowser) {
      this._dockBrowser.destroy();
      this._dockBrowser = null;
    }
    this._browsers = [];
    this.uninstallSaveExportBridge();
    this.uninstallFetchGuard();
    this.uninstallXhrGuard();
  }

  /* ---------------- 打开自定义页签（桌面端入口） ---------------- */
  openNetdiskTab() {
    try {
      if (typeof openTab === "function") {
        openTab({
          app: this.app,
          custom: {
            id: this.tabId,
            icon: "iconImage",
            title: PLUGIN_TITLE,
            data: { netdisk: 1 },
          },
        });
        return;
      }
    } catch (e) {
      console.error(TAG + " open tab failed:", e);
    }
    this.openDialog();
  }

  /* ---------------- 移动端“另存为”回调桥（与思源自身共用 window.handleSaveExportFileResult） ---------------- */
  installSaveExportBridge() {
    this._saveExportPending = new Map();
    try {
      const prev = window.handleSaveExportFileResult;
      this._prevSaveExportHandler = typeof prev === "function" ? prev : null;
      const plugin = this;
      const handler = function (requestID, resultJSON) {
        try {
          const cb = plugin._saveExportPending.get(requestID);
          if (cb) {
            plugin._saveExportPending.delete(requestID);
            let result = null;
            try {
              result = JSON.parse(resultJSON);
            } catch (e) {
              result = null;
            }
            cb(result && result.status ? result : { status: "error" });
            return;
          }
        } catch (e) {
          /* ignore */
        }
        if (plugin._prevSaveExportHandler) {
          try {
            plugin._prevSaveExportHandler.apply(window, arguments);
          } catch (e) {
            /* ignore */
          }
        }
      };
      this._saveExportHandler = handler;
      window.handleSaveExportFileResult = handler;
    } catch (e) {
      console.error(TAG + " install save-export bridge failed:", e);
    }
  }

  uninstallSaveExportBridge() {
    try {
      if (this._saveExportPending) this._saveExportPending.clear();
      if (window.handleSaveExportFileResult === this._saveExportHandler) {
        window.handleSaveExportFileResult = this._prevSaveExportHandler || undefined;
      }
    } catch (e) {
      /* ignore */
    }
    this._saveExportHandler = null;
  }

  /* ---------------- 备用：弹窗形式（页签不可用时） ---------------- */
  closeDialog() {
    if (this._dialog) {
      try {
        this._dialog.destroy();
      } catch (e) {
        /* ignore */
      }
      this._dialog = null;
    }
    if (this._dialogBrowser) {
      this._dialogBrowser.destroy();
      this._dialogBrowser = null;
    }
  }

  openDialog() {
    this.closeDialog();
    const dialog = new Dialog({
      title: PLUGIN_TITLE + " · data/assets",
      content: '<div class="' + NS + '-host"></div>',
      width: this.isMobile ? "100vw" : "min(1100px, 94vw)",
      height: this.isMobile ? "100vh" : "min(880px, 90vh)",
      destroyCallback: () => {
        if (this._dialog === dialog) {
          this._dialog = null;
          if (this._dialogBrowser) {
            this._dialogBrowser.destroy();
            this._dialogBrowser = null;
          }
        }
      },
    });
    this._dialog = dialog;
    fixDialogLayout(dialog);
    const host = dialog.element.querySelector("." + NS + "-host");
    this._dialogBrowser = new AssetBrowser(this, host);
    this._browsers.push(this._dialogBrowser);
    this._dialogBrowser.start();
  }

  /* ---------------- 配置 ---------------- */
  async saveConfig() {
    try {
      await this.saveData(CONFIG_FILE, { homePath: this.homePath, guardDelete: this.guardDelete });
    } catch (e) {
      console.error(TAG + " save config failed:", e);
    }
  }

  async setHome(path, save) {
    this.homePath = normalizeHomePath(path);
    const self = this;
    this._browsers.forEach(function (b) {
      if (!b.destroyed) b.renderHome();
    });
    if (this._dockBrowser && !this._dockBrowser.destroyed) this._dockBrowser.renderHome();
    if (this._tabBrowser && !this._tabBrowser.destroyed) this._tabBrowser.renderHome();
    if (save) await this.saveConfig();
    return this.homePath;
  }

  async setGuard(on, save) {
    this.guardDelete = !!on;
    if (save) await this.saveConfig();
    return this.guardDelete;
  }

  /* ---------------- 删除保护（拒绝式） ---------------- */
  isDeleteApi(url) {
    if (!url) return false;
    return url.indexOf("/api/file/removeFile") >= 0 || url.indexOf("/api/asset/removeUnusedAsset") >= 0;
  }

  readBody(init) {
    try {
      const b = init && init.body;
      if (typeof b === "string") return JSON.parse(b);
      if (b && typeof b === "object" && !(b instanceof FormData) && !(b instanceof URLSearchParams) && !(b instanceof Blob)) {
        return b;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  pathFromBodyString(body) {
    if (typeof body !== "string") {
      if (body && typeof body === "object" && body.path) return String(body.path);
      return "";
    }
    try {
      const o = JSON.parse(body);
      return o && o.path ? String(o.path) : "";
    } catch (e) {
      return "";
    }
  }

  isHomeFile(p) {
    if (!this.guardDelete) return false;
    const home = this.homePath || ASSETS_REL;
    const np = toRelPath(p);
    if (!np) return false;
    return np === home || np.indexOf(home + "/") === 0;
  }

  blockMsgOne() {
    return "该文件为思源网盘文件，已禁止删除，请在「" + PLUGIN_TITLE + "」面板中操作";
  }

  blockMsgMany(n) {
    return "有 " + n + " 个文件在思源网盘目录内，已阻止本次清理，请在「" + PLUGIN_TITLE + "」面板中处理";
  }

  async homeUnusedPaths() {
    try {
      const list = await api("/api/asset/getUnusedAssets", {});
      const arr = list || [];
      const ret = [];
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i] && arr[i].item ? String(arr[i].item) : "";
        if (p && this.isHomeFile(p)) ret.push(p);
      }
      return ret;
    } catch (e) {
      return [];
    }
  }

  /* ----- fetch 拦截 ----- */
  installFetchGuard() {
    if (this._fetchGuard || typeof window.fetch !== "function") return;
    const plugin = this;
    const orig = window.fetch;
    const guard = function (input, init) {
      return plugin.guardFetch(orig, this, input, init);
    };
    this._origFetch = orig;
    this._fetchGuard = guard;
    try {
      window.fetch = guard;
      console.log(TAG + " 已拦截 fetch，网盘目录内的文件禁止外部删除");
    } catch (e) {
      this._fetchGuard = null;
      console.error(TAG + " install fetch guard failed:", e);
    }
  }

  uninstallFetchGuard() {
    try {
      if (this._fetchGuard && window.fetch === this._fetchGuard && this._origFetch) {
        window.fetch = this._origFetch;
      }
    } catch (e) {
      /* ignore */
    }
    this._fetchGuard = null;
  }

  async guardFetch(orig, thisArg, input, init) {
    try {
      if (!this._bypassGuard && this.guardDelete) {
        const url = typeof input === "string" ? input : input && input.url ? String(input.url) : "";
        const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        if (method === "POST" && url.indexOf("/api/") >= 0 && this.isDeleteApi(url)) {
          if (url.indexOf("/api/asset/removeUnusedAssets") >= 0) {
            const paths = await this.homeUnusedPaths();
            if (paths.length) {
              console.log(TAG + " 已阻止清理未引用资源：" + paths.length + " 个网盘文件\n" + paths.join("\n"));
              return blockedResponse(this.blockMsgMany(paths.length));
            }
          } else {
            const body = this.readBody(init);
            const p = body && body.path ? String(body.path) : "";
            if (p && this.isHomeFile(p)) {
              console.log(TAG + " 已阻止删除：" + p);
              return blockedResponse(this.blockMsgOne());
            }
          }
        }
      }
    } catch (e) {
      console.error(TAG + " delete guard error:", e);
    }
    return orig.call(thisArg || window, input, init);
  }

  /* ----- XMLHttpRequest 拦截 ----- */
  installXhrGuard() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (this._xhrGuard || !proto || typeof proto.open !== "function" || typeof proto.send !== "function") return;
    const plugin = this;
    const origOpen = proto.open;
    const origSend = proto.send;
    this._xhrOrig = { open: origOpen, send: origSend };
    try {
      proto.open = function (method, url) {
        try {
          this.__amMethod = String(method || "").toUpperCase();
          this.__amUrl = String(url || "");
        } catch (e) {
          /* ignore */
        }
        return origOpen.apply(this, arguments);
      };
      proto.send = function (body) {
        try {
          const url = this.__amUrl || "";
          const method = this.__amMethod || "";
          if (!plugin._bypassGuard && plugin.guardDelete && method === "POST" && plugin.isDeleteApi(url)) {
            const p = plugin.pathFromBodyString(body);
            if (p && plugin.isHomeFile(p)) {
              console.log(TAG + " 已阻止 XHR 删除：" + p);
              try {
                showMessage(plugin.blockMsgOne(), 6000);
              } catch (e) {
                /* ignore */
              }
              try {
                this.abort();
              } catch (e) {
                /* ignore */
              }
              return;
            }
          }
        } catch (e) {
          console.error(TAG + " xhr guard error:", e);
        }
        return origSend.apply(this, arguments);
      };
      this._xhrGuard = true;
      console.log(TAG + " 已拦截 XMLHttpRequest，网盘目录内的文件禁止外部删除");
    } catch (e) {
      this._xhrGuard = false;
      console.error(TAG + " install xhr guard failed:", e);
    }
  }

  uninstallXhrGuard() {
    try {
      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (this._xhrOrig && proto) {
        proto.open = this._xhrOrig.open;
        proto.send = this._xhrOrig.send;
      }
    } catch (e) {
      /* ignore */
    }
    this._xhrOrig = null;
    this._xhrGuard = false;
  }

  async removeFile(p, bypass) {
    const prev = this._bypassGuard;
    if (bypass) this._bypassGuard = true;
    try {
      return await api("/api/file/removeFile", { path: p });
    } finally {
      this._bypassGuard = prev;
    }
  }

  /* ---------------- 面板内设置 ---------------- */
  openSettings(browser) {
    const plugin = this;
    const current = browser && browser.state ? browser.state.dir : this.homePath;
    const dialog = new Dialog({
      title: PLUGIN_TITLE + "设置",
      content:
        '<div class="' + NS + '-settings">' +
        '<div class="' + NS + '-settings__row">' +
        '<div class="' + NS + '-settings__label">网盘目录</div>' +
        '<div class="' + NS + '-settings__desc">点击顶部的 ⌂ 按钮时进入的目录。相对 data 目录，仅支持 assets 及其子目录，例如 <code>assets</code> 或 <code>assets/同步盘</code>。</div>' +
        '<input class="b3-text-field fn__block" id="' + NS + '-home-input" placeholder="assets" />' +
        "</div>" +
        '<div class="' + NS + '-settings__row">' +
        '<label class="fn__flex" style="align-items:center;gap:8px;cursor:pointer;">' +
        '<input type="checkbox" class="b3-switch fn__flex-center" id="' + NS + '-guard-input" />' +
        '<span class="' + NS + '-settings__label" style="margin:0;">禁止外部删除</span>' +
        "</label>" +
        '<div class="' + NS + '-settings__desc" style="margin-top:6px;">思源本体或其它插件删除网盘目录内的文件时直接拒绝；网盘面板内的删除不受影响。</div>' +
        "</div>" +
        '<div class="' + NS + '-settings__foot">' +
        '<button class="b3-button b3-button--cancel" id="' + NS + '-s-cancel">取消</button>' +
        '<button class="b3-button b3-button--outline" id="' + NS + '-s-use">使用当前目录</button>' +
        '<button class="b3-button b3-button--text" id="' + NS + '-s-save">保存</button>' +
        "</div></div>",
      width: this.isMobile ? "92vw" : "560px",
      height: "auto",
    });

    const input = dialog.element.querySelector("#" + NS + "-home-input");
    const guard = dialog.element.querySelector("#" + NS + "-guard-input");
    if (input) input.value = this.homePath;
    if (guard) guard.checked = !!this.guardDelete;

    const cancel = dialog.element.querySelector("#" + NS + "-s-cancel");
    const use = dialog.element.querySelector("#" + NS + "-s-use");
    const save = dialog.element.querySelector("#" + NS + "-s-save");

    if (cancel) cancel.addEventListener("click", () => dialog.destroy());
    if (use) {
      use.addEventListener("click", () => {
        if (input) input.value = normalizeHomePath(current);
      });
    }
    if (save) {
      save.addEventListener("click", async () => {
        const p = await plugin.setHome(input ? input.value : "", false);
        await plugin.setGuard(guard ? guard.checked : true, false);
        await plugin.saveConfig();
        dialog.destroy();
        showMessage("网盘目录：" + p + "；禁止外部删除：" + (plugin.guardDelete ? "已开启" : "已关闭"), 5000);
      });
    }
  }
};
