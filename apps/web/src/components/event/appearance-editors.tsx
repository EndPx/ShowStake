"use client";
// Adapts CommitPass appearance-editors: same preset/customizer/confirm interaction.
import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {Check,ImagePlus,Moon,Palette,Search,Sun,X} from 'lucide-react';
import {COVER_TEMPLATES,DEFAULT_EVENT_COVER,eventThemeVariables,readableThemeText,safeEventCover,type EventAppearance} from '@/lib/event-appearance';

const STYLES=[{id:'minimal',name:'Minimal'},{id:'aurora',name:'Aurora'},{id:'confetti',name:'Confetti'},{id:'grid',name:'Grid'}] as const;
const COLORS=['#087295','#04142b','#385fd1','#7951b0','#ca356e','#246b55','#bf890c','#e9792e'];

function AppearanceDialog({title,description,children,onClose,wide=false}:{title:string;description:string;children:ReactNode;onClose:()=>void;wide?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current,trigger=document.activeElement as HTMLElement|null;if(!dialog)return;dialog.showModal();return()=>{dialog.close();trigger?.focus();};},[]);
  return <dialog ref={ref} className={`ss-editor-dialog ss-appearance-dialog${wide?' ss-appearance-dialog--wide':''}`} aria-labelledby="appearance-heading" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="ss-dialog-content"><div className="ss-dialog-heading"><h2 id="appearance-heading">{title}</h2><button className="ss-icon-button" type="button" aria-label="Close editor" onClick={onClose}><X size={19}/></button></div><p className="ss-appearance-intro">{description}</p>{children}</div>
  </dialog>;
}
function DialogActions({onClose,label}:{onClose:()=>void;label:string}) {
  return <div className="ss-appearance-actions"><button type="button" className="button button--secondary" onClick={onClose}>Cancel</button><button type="submit" className="button button--dark">{label}<Check size={16}/></button></div>;
}
export function ThemeEditor({value,onChange,onConfirm,onClose}:{value:EventAppearance;onChange:(value:EventAppearance)=>void;onConfirm:()=>void;onClose:()=>void}) {
  return <AppearanceDialog title="Make it yours" description="Choose the look of your event. Preview your changes, then save the theme." onClose={onClose}>
    <form onSubmit={e=>{e.preventDefault();onConfirm();}}>
      <div className="ss-theme-presets">{STYLES.map(style=><button key={style.id} type="button" aria-pressed={value.style===style.id} className={value.style===style.id?'selected':''} onClick={()=>onChange({...value,style:style.id})}>
        <div className={`ss-theme-preview ss-theme-${style.id}`} style={eventThemeVariables({...value,style:style.id}) as CSSProperties}><span/><i/><i/><i/></div><span>{style.name}{value.style===style.id&&<Check size={14}/>}</span>
      </button>)}</div>
      <fieldset className="ss-theme-field"><legend>Color</legend><div className="ss-theme-swatches">{COLORS.map(color=><button type="button" key={color} aria-label={`Use ${color}`} aria-pressed={value.color===color} className={value.color===color?'selected':''} style={{background:color,color:readableThemeText(color)}} onClick={()=>onChange({...value,color})}>{value.color===color&&<Check size={17}/>}</button>)}<label className="ss-custom-color"><input type="color" aria-label="Custom accent color" value={value.color} onChange={e=>onChange({...value,color:e.target.value})}/><Palette size={16}/><span>Custom</span></label></div></fieldset>
      <fieldset className="ss-theme-field"><legend>Title font</legend><div className="ss-theme-fonts">{([{id:'sans',name:'Default'},{id:'serif',name:'Editorial'},{id:'mono',name:'Mono'}] as const).map(font=><button type="button" key={font.id} aria-pressed={value.font===font.id} className={value.font===font.id?'selected':''} onClick={()=>onChange({...value,font:font.id})}><strong style={{fontFamily:font.id==='serif'?'var(--font-serif)':font.id==='mono'?'monospace':'var(--font-sans)'}}>Ag</strong><span>{font.name}</span></button>)}</div></fieldset>
      <fieldset className="ss-theme-field"><legend>Appearance</legend><div className="ss-theme-modes">{([{id:'light',name:'Light',Icon:Sun},{id:'dark',name:'Dark',Icon:Moon}] as const).map(({id,name,Icon})=><button key={id} type="button" aria-pressed={value.mode===id} className={value.mode===id?'selected':''} onClick={()=>onChange({...value,mode:id})}><Icon size={17}/>{name}</button>)}</div></fieldset>
      <DialogActions onClose={onClose} label="Use this theme"/>
    </form>
  </AppearanceDialog>;
}
export function CoverEditor({value,onConfirm,onClose}:{value:string;onConfirm:(cover:string)=>void;onClose:()=>void}) {
  const [candidate,setCandidate]=useState(value||DEFAULT_EVENT_COVER),[query,setQuery]=useState(''),[imageUrl,setImageUrl]=useState(''),[error,setError]=useState('');
  const templates=COVER_TEMPLATES.filter(t=>`${t.name} ${t.category}`.toLowerCase().includes(query.toLowerCase()));
  return <AppearanceDialog title="Choose a cover" description="Pick a CommitPass cover template or use your own publicly hosted image." onClose={onClose} wide>
    <form onSubmit={e=>{e.preventDefault();const cover=safeEventCover(candidate);if(!cover){setError('Choose a cover or enter a valid HTTPS image URL.');return;}onConfirm(cover);}}>
      <div className="ss-cover-selected"><img key={candidate} src={candidate} alt="Selected cover preview" referrerPolicy="no-referrer" onError={()=>setError("This image could not load. Choose a template or check the public image link.")}/><div><ImagePlus size={22}/><strong>Your event cover</strong><p className="ss-muted">A square image works best.</p></div></div>
      <label className="ss-cover-search"><Search size={17}/><input aria-label="Search cover templates" placeholder="Search templates" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <div className="ss-cover-grid">{templates.map(t=><button type="button" key={t.id} aria-pressed={candidate===t.url} className={candidate===t.url?'selected':''} onClick={()=>{setCandidate(t.url);setError('');}}><img src={t.url} alt={`${t.name} cover template`} loading="lazy"/><span>{t.name}{candidate===t.url&&<Check size={16}/>}</span><small>{t.category}</small></button>)}</div>
      {!templates.length&&<p className="ss-muted">No matching cover. Try another search.</p>}
      <details className="ss-custom-cover"><summary>Use your own image link</summary><label>Public HTTPS image URL<input type="url" placeholder="https://…" value={imageUrl} onChange={e=>setImageUrl(e.target.value)}/></label><button className="button button--secondary" type="button" onClick={()=>{const url=safeEventCover(imageUrl);if(!url){setError('Enter a public HTTPS image URL.');return;}setCandidate(url);setError('');}}>Preview image</button><p className="ss-muted">The image link is public and must remain accessible to your guests.</p></details>
      {error&&<p role="alert" className="ss-form-error">{error}</p>}<DialogActions onClose={onClose} label="Use this cover"/>
    </form>
  </AppearanceDialog>;
}
