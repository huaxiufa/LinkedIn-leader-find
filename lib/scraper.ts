import { chromium, type Locator, type Page } from "playwright";
import { lookup } from "node:dns/promises";
import { normalizeLinkedInUrl } from "./normalize";

export type ScrapedEngagement = { profileUrl:string; name:string; headline?:string; jobTitle?:string; company?:string; type:"COMMENT"|"REACTION"; reactionType?:string; commentText?:string; engagedAt?:Date };
export type ScrapeResult = { engagements:ScrapedEngagement[]; warnings:string[] };
const clean=(v:string|null|undefined)=>(v??"").replace(/\s+/g," ").trim();
const profile=(v:string)=>{const u=normalizeLinkedInUrl(v);return /linkedin\.com\/in\//i.test(u)?u:"";};
const generic=(v:string)=>/^(like|comment|repost|send|follow|most relevant|most recent|reactions?|likes?|people who reacted|close|cancel|done|back|next|previous|see all|show more|load more|connections?|grow your network|my network|notifications?|messaging|jobs|home|search|me|for business|celebrate|support|love|insightful|funny)$/i.test(clean(v))||clean(v).length<2;
async function connect(){const configured=new URL(process.env.LINKEDIN_CDP_URL??"http://host.docker.internal:9222");let host=configured.hostname;if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)&&host!=="localhost"){const a=await lookup(host,{all:true});const v4=a.find(x=>x.family===4);if(!v4)throw new Error(`Could not resolve ${host} to IPv4.`);host=v4.address;}const endpoint=`http://${host}:${configured.port||"9222"}`;const r=await fetch(`${endpoint}/json/version`,{headers:{Host:host}});if(!r.ok)throw new Error(`Chrome CDP endpoint returned HTTP ${r.status}.`);const v=await r.json() as {Browser?:string;webSocketDebuggerUrl?:string};console.log(`Chrome CDP browser: ${v.Browser??"unknown"}`);if(!v.webSocketDebuggerUrl)throw new Error("Chrome CDP did not return a browser WebSocket endpoint.");const browser=await chromium.connectOverCDP(v.webSocketDebuggerUrl,{timeout:90000});const context=browser.contexts()[0];if(!context)throw new Error("Chrome CDP connected, but no browser context is available.");return {browser,page:await context.newPage()};}
async function nearestClickable(node:Locator){const c=node.locator("xpath=ancestor-or-self::*[self::button or @role='button' or self::a][1]");return await c.count().catch(()=>0)?c.first():node;}
async function controls(page:Page,kind:"comments"|"reactions",postUrl:string){const countRe=kind==="comments"?/\b\d[\d,.]*\s+comments?\b/i:/\b\d[\d,.]*\s+(?:reactions?|likes?)\b/i;const labelRe=kind==="comments"?/comment/i:/reaction|like/i;const all=page.locator("button,[role='button'],a,[tabindex='0'],span");const n=Math.min(await all.count().catch(()=>0),1800);const hits:string[]=[];for(let i=0;i<n;i++){const x=all.nth(i);if(!(await x.isVisible().catch(()=>false)))continue;const text=clean(await x.innerText().catch(()=>""));const aria=clean(await x.getAttribute("aria-label").catch(()=>""));const title=clean(await x.getAttribute("title").catch(()=>""));const data=clean(await x.getAttribute("data-view-name").catch(()=>""));const s=`${text} ${aria} ${title} ${data}`;if(labelRe.test(s)&&hits.length<30)hits.push(s.slice(0,140));if(countRe.test(text)||countRe.test(aria)||countRe.test(title))return nearestClickable(x);}console.log(`${kind} control diagnostics: ${hits.join(" | ")||"no labelled candidates"}`);return null;}
function overlayCandidates(page:Page){return page.locator('[role="dialog"],[role="listbox"],[role="list"],[role="tabpanel"],.artdeco-modal,.artdeco-popover,[data-test-modal],[data-test-dialog],[data-test-popover]');}
function profileAnchors(page:Page|Locator){return page.locator('a[href*="/in/"],a[data-profile-url],a[data-test-profile-url]');}
async function snapshotProfileVisibility(page:Page){const seen=new Map<string,boolean>();const anchors=profileAnchors(page);const n=Math.min(await anchors.count().catch(()=>0),2500);for(let i=0;i<n;i++){const a=anchors.nth(i);const href=profile((await a.getAttribute("href").catch(()=>""))||(await a.getAttribute("data-profile-url").catch(()=>""))||(await a.getAttribute("data-test-profile-url").catch(()=>""))||"");if(href)seen.set(href.toLowerCase(),await a.isVisible().catch(()=>false));}return seen;}
async function reactionSurfaceAfterClick(page:Page){for(let i=0;i<12;i++){const specific=overlayCandidates(page).filter({hasText:/people who reacted|\breactions?\b|\blikes?/i}).last();if(await specific.count().catch(()=>0))return specific;await page.waitForTimeout(300);}return null;}
function commentSurface(page:Page){return overlayCandidates(page).filter({hasText:/comment|reply/i}).last();}
async function clickControl(page:Page,c:Locator,label:string){console.log(`${label} control found; clicking it.`);await c.scrollIntoViewIfNeeded().catch(()=>{});await c.click({timeout:5000}).catch(async()=>c.click({timeout:5000,force:true}));await page.waitForTimeout(1200);}
async function climbComment(anchor:Locator){
  let node=anchor;
  for(let i=0;i<40;i++){
    const text=clean(await node.textContent().catch(()=> ""));
    const cls=clean((await node.getAttribute("class").catch(()=> ""))+" "+(await node.getAttribute("data-view-name").catch(()=> ""))+" "+(await node.getAttribute("data-test-id").catch(()=> "")));
    const hasReply=await node.locator("button,[role='button'],a").filter({hasText:/^reply$/i}).count().catch(()=>0);
    if(hasReply && text.length<15000 && /\breply\b/i.test(text)) return node;
    if(/(^|[\s_-])comment(?!ary)/i.test(cls) && text.length<15000 && /\breply\b/i.test(text)) return node;
    const p=node.locator("xpath=..");
    if(!(await p.count().catch(()=>0))) break;
    node=p;
  }
  return null;
}
async function extractComments(page:Page,max:number,postUrl:string){
  const c=await controls(page,"comments",postUrl);
  if(c)await clickControl(page,c,"Comment interaction");else console.log("Comment count control not found; scanning current comment UI only.");

  // LinkedIn often lazy-loads comments only after the comment control is clicked and
  // the feed is scrolled. Do that before inspecting profile links.
  for(let pass=0;pass<10;pass++){
    const more=page.locator("button,[role='button'],a").filter({hasText:/load more comments?|more comments?|show more comments?/i}).first();
    if(await more.count().catch(()=>0)&&await more.isVisible().catch(()=>false)){
      await more.click({timeout:3000}).catch(()=>{});
      await page.waitForTimeout(700);
    }
    await page.keyboard.press("PageDown").catch(()=>{});
    await page.waitForTimeout(450);
  }

  const selectors=[
    "[class*='comments-comment-item']",
    "[class*='feed-shared-update-v2__comment-item']",
    "[data-view-name*='comment']",
    "[data-test-id*='comment']",
    "article.comments-comment-item",
    "li.comments-comment-item"
  ];
  const items=page.locator(selectors.join(","));
  const itemCount=await items.count().catch(()=>0);
  const out:ScrapedEngagement[]=[];const seen=new Set<string>();const rejected:string[]=[];

  // First pass: real comment containers. Never treat arbitrary page profile links as comments.
  if(itemCount){
    const n=Math.min(itemCount,Math.max(max*4,50));
    for(let i=0;i<n&&out.length<max;i++){
      const item=items.nth(i);if(!(await item.isVisible().catch(()=>false)))continue;
      const anchors=profileAnchors(item);const an=Math.min(await anchors.count().catch(()=>0),8);
      for(let j=0;j<an&&out.length<max;j++){
        const x=anchors.nth(j);if(!(await x.isVisible().catch(()=>false)))continue;
        const href=profile((await x.getAttribute("href").catch(()=> ""))||(await x.getAttribute("data-profile-url").catch(()=> ""))||(await x.getAttribute("data-test-profile-url").catch(()=> ""))||"");
        const rawName=clean((await x.textContent().catch(()=> ""))||(await x.getAttribute("aria-label").catch(()=> "")));
        const name=rawName.split(/•|\n/)[0].trim();const key=href.toLowerCase();
        if(!href||!name||generic(name)||seen.has(key))continue;
        const txt=clean(await item.textContent().catch(()=> ""));
        if(!/\breply\b|\blike\b|\btranslate\b/i.test(txt))continue;
        const lines=txt.split(/\n+/).map(clean).filter(Boolean);
        const idx=lines.findIndex(v=>v.toLowerCase().includes(name.toLowerCase()));
        const body=idx>=0?lines.slice(idx+1).filter(v=>!/^(like|reply|follow|edited|see more|see less|translate)$/i.test(v)).join(" ").slice(0,5000):"";
        seen.add(key);out.push({profileUrl:href,name,type:"COMMENT",commentText:body||undefined});break;
      }
    }
  }

  // Second pass: current LinkedIn builds sometimes omit the old comment-item class.
  // Walk upward from each visible profile anchor, but require a nearby Reply action.
  if(out.length<max){
    const root=commentSurface(page);
    const scope=await root.count().catch(()=>0)?root:page.locator("main").first();
    const anchors=profileAnchors(scope);
    const an=Math.min(await anchors.count().catch(()=>0),Math.max(max*20,300));
    for(let i=0;i<an&&out.length<max;i++){
      const x=anchors.nth(i);if(!(await x.isVisible().catch(()=>false)))continue;
      const href=profile((await x.getAttribute("href").catch(()=> ""))||(await x.getAttribute("data-profile-url").catch(()=> ""))||(await x.getAttribute("data-test-profile-url").catch(()=> ""))||"");
      const rawName=clean((await x.textContent().catch(()=> ""))||(await x.getAttribute("aria-label").catch(()=> "")));
      const name=rawName.split(/•|\n/)[0].trim();const key=href.toLowerCase();
      if(!href||!name||generic(name)||seen.has(key))continue;
      const box=await climbComment(x);
      if(!box){if(rejected.length<20)rejected.push(name+" => "+href);continue;}
      const txt=clean(await box.textContent().catch(()=> ""));if(txt.length>15000)continue;
      const lines=txt.split(/\n+/).map(clean).filter(Boolean);
      const idx=lines.findIndex(v=>v.toLowerCase().includes(name.toLowerCase()));
      const body=idx>=0?lines.slice(idx+1).filter(v=>!/^(like|reply|follow|edited|see more|see less|translate)$/i.test(v)).join(" ").slice(0,5000):"";
      seen.add(key);out.push({profileUrl:href,name,type:"COMMENT",commentText:body||undefined});
    }
  }

  console.log("Comment diagnostics: itemContainers="+itemCount+", captured="+out.length+", rejected="+(rejected.join(" || ")||"none"));
  return out;
}
async function extractReactions(page:Page,max:number,postUrl:string,warnings:string[]){const c=await controls(page,"reactions",postUrl);if(!c){warnings.push("Could not locate the reaction interaction control inside the LinkedIn post.");return [];}const before=await snapshotProfileVisibility(page);await clickControl(page,c,"Reaction interaction");const reactions:ScrapedEngagement[]=[];const emitted=new Set<string>();for(let r=0;r<24&&reactions.length<max;r++){const anchors=profileAnchors(page);const n=Math.min(await anchors.count().catch(()=>0),2500);let found=0;for(let i=0;i<n&&reactions.length<max;i++){const a=anchors.nth(i);if(!(await a.isVisible().catch(()=>false)))continue;const href=profile((await a.getAttribute("href").catch(()=>""))||(await a.getAttribute("data-profile-url").catch(()=>""))||(await a.getAttribute("data-test-profile-url").catch(()=>""))||"");const name=clean((await a.textContent().catch(()=>""))||(await a.getAttribute("aria-label").catch(()=>"")));const key=href.toLowerCase();if(!href||!name||generic(name)||emitted.has(key))continue;const beforeVisible=before.get(key)===true;const surface=await reactionSurfaceAfterClick(page);const inSurface=surface?await a.locator("xpath=ancestor-or-self::*").filter({has:surface}).count().catch(()=>0):0;if(beforeVisible&&!inSurface)continue;const context=clean(await a.locator("xpath=ancestor::*[self::li or self::div or self::article][1]").textContent().catch(()=>""));if(!inSurface&&/comment|reply/i.test(context)&&!/reaction|react|people who/i.test(context))continue;emitted.add(key);reactions.push({profileUrl:href,name,type:"REACTION",reactionType:"UNKNOWN"});found++;}const surface=await reactionSurfaceAfterClick(page);if(surface){await surface.focus().catch(()=>{});await surface.press("PageDown").catch(()=>{});}await page.waitForTimeout(500);if(!found&&!surface)break;}if(!reactions.length){warnings.push("Reaction interaction opened, but no reaction profiles could be identified without using unrelated page-wide profiles.");}console.log(`Reaction extraction: ${reactions.length} profile(s) captured.`);return reactions;}
export async function scrapePublicPost(postUrl:string,options:{maxComments?:number;maxReactions?:number}={}):Promise<ScrapeResult>{const maxComments=options.maxComments??500,maxReactions=options.maxReactions??500,warnings:string[]=[];const {browser,page}=await connect();try{await page.goto(postUrl,{waitUntil:"domcontentloaded",timeout:30000});await page.waitForTimeout(2000);const signedOut=await page.locator('input[name="session_key"],form[action*="login"]').count().catch(()=>0);console.log(`LinkedIn session: ${signedOut?"SIGNED OUT":"SIGNED IN"}`);if(signedOut)warnings.push("LinkedIn appears to be signed out in the connected Chrome profile.");const comments=await extractComments(page,maxComments,postUrl);const reactions=await extractReactions(page,maxReactions,postUrl,warnings);const merged=new Map<string,ScrapedEngagement>();for(const item of [...reactions,...comments]){const key=normalizeLinkedInUrl(item.profileUrl).toLowerCase();if(!key)continue;const old=merged.get(key);if(!old||item.type==="COMMENT")merged.set(key,item);}console.log(`Engagement merge: comments=${comments.length}, reactions=${reactions.length}, unique=${merged.size}.`);return{engagements:[...merged.values()],warnings};}finally{await page.close().catch(()=>{});await browser.close().catch(()=>{});}}
