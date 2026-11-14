// CommitPass appearance schema/palette mechanism, adapted to ShowStake metadata.
export type EventAppearance = {
  style: 'minimal' | 'aurora' | 'confetti' | 'grid';
  color: string;
  font: 'sans' | 'serif' | 'mono';
  mode: 'light' | 'dark';
};
export const DEFAULT_EVENT_APPEARANCE: EventAppearance = {style:'minimal',color:'#087295',font:'sans',mode:'light'};
export const COVER_TEMPLATES = [
  {id:'together',name:'Together',category:'Community',url:'/event-covers/together.webp'},
  {id:'good-plans',name:'Good plans',category:'Creative',url:'/event-covers/good-plans.webp'},
  {id:'workshop',name:'Workshop',category:'Workshops',url:'/event-covers/workshop.webp'},
] as const;
export const DEFAULT_EVENT_COVER = COVER_TEMPLATES[0].url;
const PREFIX = 'ShowStake event metadata v1\n';

export function normalizeAppearance(value?: Partial<EventAppearance> | null): EventAppearance {
  return {
    style: ['minimal','aurora','confetti','grid'].includes(value?.style??'')?value!.style!:DEFAULT_EVENT_APPEARANCE.style,
    color: /^#[0-9a-f]{6}$/i.test(value?.color??'')?value!.color!.toLowerCase():DEFAULT_EVENT_APPEARANCE.color,
    font: ['sans','serif','mono'].includes(value?.font??'')?value!.font!:DEFAULT_EVENT_APPEARANCE.font,
    mode: value?.mode==='dark'?'dark':'light',
  };
}
export function safeEventCover(value:unknown):string|null {
  if(typeof value!=='string'||value.length>2048)return null;
  if(COVER_TEMPLATES.some(t=>t.url===value))return value;
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
export function encodeEventDetails(description:string,appearance:EventAppearance,cover:string):string|null {
  const image=safeEventCover(cover);if(!image||!description.trim())return null;
  const encoded=PREFIX+JSON.stringify({description,appearance:normalizeAppearance(appearance),cover:image});
  return new TextEncoder().encode(encoded).length<=8192?encoded:null;
}
export function decodeEventDetails(raw:unknown):{description:string;appearance:EventAppearance|null;cover:string|null} {
  const description=typeof raw==='string'?raw:'';
  const legacy={description,appearance:null,cover:null};
  if(!description.startsWith(PREFIX))return legacy;
  try {
    const data=JSON.parse(description.slice(PREFIX.length));
    if(!data||typeof data.description!=='string'||!data.description.trim()||!data.appearance||typeof data.appearance!=='object'||!safeEventCover(data.cover))return legacy;
    return {description:data.description,appearance:normalizeAppearance(data.appearance),cover:safeEventCover(data.cover)};
  }catch{return legacy;}
}
export function shuffleEventAppearance(current:EventAppearance,cover:string,random=Math.random):{appearance:EventAppearance;cover:string} {
  const covers=COVER_TEMPLATES.filter(t=>t.url!==cover),styles=['minimal','aurora','confetti','grid'] as const;
  const styleOptions=styles.filter(x=>x!==current.style);
  const index=(length:number)=>Math.min(length-1,Math.max(0,Math.floor(random()*length)));
  return {cover:covers[index(covers.length)]!.url,appearance:{...current,style:styleOptions[index(styleOptions.length)]!}};
}

function mix(a:string,b:string,amount:number) {
  return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*amount+parseInt(b.slice(i,i+2),16)*(1-amount)).toString(16).padStart(2,'0')).join('');
}
export function readableThemeText(color:string):string {
  const c=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return .2126*c[0]!+.7152*c[1]!+.0722*c[2]!>.179?'#04142b':'#ffffff';
}
export function eventThemeVariables(raw:EventAppearance):Record<string,string> {
  const a=normalizeAppearance(raw),dark=a.mode==='dark',canvas=dark?mix(a.color,'#101924',.09):'#faf9f6';
  const accent=dark?mix(a.color,'#ffffff',.4):readableThemeText(a.color)==='#04142b'?mix(a.color,'#04142b',.4):a.color;
  const primary=dark?accent:a.color;
  return {
    '--canvas':canvas,'--white':dark?'#1d2a39':'#ffffff','--ink':dark?'#f4f7fa':'#04142b','--muted':dark?'#b7c4d3':'#5b6676',
    '--line':dark?'#ffffff25':'#dce3e8','--accent':accent,'--accent-soft':mix(a.color,canvas,.14),
    '--green':dark?'#a6d8ad':'#315c45','--green-soft':dark?'#234633':'#e5eee4',
    '--theme-glow':a.color+(dark?'30':'19'),'--theme-sky':mix('#91bbdc',canvas,dark?.06:.16),
    '--theme-wash':mix(a.color,canvas,dark?.24:.14),'--theme-mist':mix(a.color,canvas,dark?.12:.06),
    '--theme-primary':primary,'--theme-primary-ink':readableThemeText(primary),
    '--editor-panel':dark?'#ffffff09':'#04142b05','--editor-input':dark?'#ffffff0c':'#04142b06',
    '--header-surface':dark?'rgb(16 25 36 / 80%)':'rgb(250 249 246 / 70%)',
    '--color-error':dark?'#ffb5ad':'#a12622','--color-error-bg':dark?'#4a282b':'#fceceb',
    '--event-heading-font':a.font==='serif'?'var(--font-serif), Georgia, serif':a.font==='mono'?'ui-monospace, monospace':'var(--font-sans), sans-serif',
    colorScheme:a.mode,
  };
}
