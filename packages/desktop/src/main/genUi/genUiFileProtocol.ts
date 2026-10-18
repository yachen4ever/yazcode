import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getZCodeDataRootDir } from "@zcode/services/node";
import {
  GEN_UI_FILE_SCHEME,
  GEN_UI_HTML_MAX_BYTES,
  GEN_UI_OUTPUT_DIRECTORY,
  genUiPathSchema,
} from "@zcode/shared/gen-ui";

interface GenUiSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{
      scheme: string;
      privileges: { standard: boolean; secure: boolean; supportFetchAPI: boolean };
    }>,
  ): void;
}

interface GenUiProtocolRouter {
  handle(scheme: string, handler: (request: { url: string }) => Promise<Response> | Response): void;
}

/** Gen UI 输出根：数据目录下固定 visualizations/，由 Host 决定，模型永不选择。 */
export function resolveGenUiOutputRoot(): string {
  return join(getZCodeDataRootDir(), GEN_UI_OUTPUT_DIRECTORY);
}

/**
 * Electron 要求 privileged scheme 在 app ready 前注册。
 * standard 让 iframe 能把 gen-ui:// 当文档加载；不给 supportFetchAPI，
 * guest 页面无法用 fetch 探测协议面。
 */
export function registerGenUiFileScheme(protocol: GenUiSchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: GEN_UI_FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false },
    },
  ]);
}

/** 拒绝输出根下的任何符号链接段（根本身可经符号链接解析，与上游一致）。 */
function assertNoSymlinkUnderRoot(realRoot: string, realCandidate: string): void {
  const rest = realCandidate.slice(realRoot.length).replace(/^[\\/]/, "");
  if (!rest) return;
  let current = realRoot;
  for (const segment of rest.split(/[\\/]/)) {
    current = `${current}${current.endsWith("\\") || current.endsWith("/") ? "" : "\\"}${segment}`;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Gen UI path segment is a symbolic link: ${current}`);
    }
  }
}

function assertReadableGenUiFile(root: string, candidate: string): string {
  // wire 层 schema 先拒一遍（绝对路径、无 ..、小写连字符 .html 文件名）。
  genUiPathSchema.parse(candidate);
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const rootWithSep =
    realRoot.endsWith("\\") || realRoot.endsWith("/") ? realRoot : `${realRoot}\\`;
  if (!realCandidate.startsWith(rootWithSep)) {
    throw new Error(`Gen UI path escapes the output root: ${candidate}`);
  }
  assertNoSymlinkUnderRoot(realRoot, realCandidate);
  const stat = lstatSync(realCandidate);
  if (!stat.isFile()) throw new Error(`Gen UI path is not a regular file: ${candidate}`);
  if (stat.size > GEN_UI_HTML_MAX_BYTES) {
    throw new Error(`Gen UI file exceeds ${GEN_UI_HTML_MAX_BYTES} bytes: ${candidate}`);
  }
  return realCandidate;
}

/** 根文档统一隐藏原生滚动条（宿主按内容测高撑开，滚动由会话承接）。 */
const GEN_UI_DOCUMENT_SCROLLBAR_STYLE =
  '<style id="zcode-gen-ui-document-scrollbar">html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>';

/**
 * guest 是内容测量的唯一来源：合并到下一动画帧读几何，只读不写根节点高度；
 * 相同宽度下高度增量等于视口增量时不反馈（vh/百分比高度随宿主调整的死循环抑制）。
 */
const GEN_UI_HEIGHT_BRIDGE_SCRIPT = `<script id="zcode-gen-ui-height-bridge">(function(){
if(window.parent===window)return;
var last=null;var scheduled=false;
function measure(){
  scheduled=false;
  var vh=window.innerHeight;
  var doc=document;
  var width=doc.documentElement?doc.documentElement.clientWidth:0;
  var height=0;
  var nodes=doc.body?Array.prototype.filter.call(doc.body.children,function(el){return !/^(script|style|link)$/i.test(el.tagName);}):[];
  if(nodes.length===1){
    var el=nodes[0];
    height=Math.max(el.getBoundingClientRect().bottom,el.scrollHeight);
  }else if(nodes.length>1){
    var bottom=0;
    for(var i=0;i<nodes.length;i++){var r=nodes[i].getBoundingClientRect();if(r.bottom>bottom)bottom=r.bottom;}
    height=bottom;
  }else{
    height=doc.body?doc.body.scrollHeight:0;
  }
  if(doc.body){
    var s=getComputedStyle(doc.body);
    height+=parseFloat(s.paddingTop||"0")+parseFloat(s.paddingBottom||"0");
  }
  height=Math.ceil(height);
  if(last&&last.w===width&&last.h===height)return;
  if(last&&last.w===width&&height>last.h&&height-last.h===vh-last.vh)return;
  last={w:width,h:height,vh:vh};
  try{window.parent.postMessage({type:"zcode:gen-ui-size",height:height,width:width},"*");}catch(e){}
}
function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(measure);}
function watch(){
  new ResizeObserver(schedule).observe(document.documentElement);
  if(document.body)new ResizeObserver(schedule).observe(document.body);
  new MutationObserver(function(mutations){
    for(var i=0;i<mutations.length;i++){
      var added=mutations[i].addedNodes;
      for(var j=0;j<added.length;j++){
        if(added[j].nodeType===1)try{new ResizeObserver(schedule).observe(added[j]);}catch(e){}
      }
    }
    schedule();
  }).observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener("resize",schedule);
  schedule();
}
if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",watch);}else{watch();}
})();</script>`;

function assembleGenUiDocument(html: string): string {
  const headIndex = /<head[^>]*>/i.exec(html);
  if (headIndex) {
    const at = headIndex.index + headIndex[0].length;
    return (
      html.slice(0, at) +
      GEN_UI_DOCUMENT_SCROLLBAR_STYLE +
      GEN_UI_HEIGHT_BRIDGE_SCRIPT +
      html.slice(at)
    );
  }
  return GEN_UI_DOCUMENT_SCROLLBAR_STYLE + GEN_UI_HEIGHT_BRIDGE_SCRIPT + html;
}

const GEN_UI_ERROR_PAGE_BODY = (message: string) =>
  assembleGenUiDocument(
    `<div style="font:13px/1.6 system-ui,sans-serif;color:#888;padding:12px 16px">⚠ ${message}</div>`,
  );

function textResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 主进程是唯一授权点：renderer 传来的只是文件标识，不是读取授权。
 * 输出根校验、符号链接拒绝、类型与 5MB 体积限制都在这里完成。
 */
export function installGenUiFileProtocol(
  protocol: GenUiProtocolRouter,
  dependencies: { getOutputRoot?: () => string } = {},
): void {
  const getOutputRoot = dependencies.getOutputRoot ?? resolveGenUiOutputRoot;
  protocol.handle(GEN_UI_FILE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "local" || url.pathname !== "/file") {
        return textResponse(GEN_UI_ERROR_PAGE_BODY("Invalid Gen UI URL."));
      }
      const path = url.searchParams.get("path") ?? "";
      const realCandidate = assertReadableGenUiFile(getOutputRoot(), path);
      // 读取与校验之间可能被并发改动：realpath 之后再取一次内容体积上限。
      const html = await readFile(realCandidate, "utf8");
      if (Buffer.byteLength(html, "utf8") > GEN_UI_HTML_MAX_BYTES) {
        return textResponse(GEN_UI_ERROR_PAGE_BODY("Gen UI file exceeds the size limit."));
      }
      return textResponse(assembleGenUiDocument(html));
    } catch (error) {
      return textResponse(
        GEN_UI_ERROR_PAGE_BODY(
          error instanceof Error &&
            /escapes|symbolic link|not a regular|exceeds/i.test(error.message)
            ? "该可视化文件未通过安全校验，已拒绝读取。"
            : "可视化源文件不可用（可能已被移动或删除）。",
        ),
      );
    }
  });
}
