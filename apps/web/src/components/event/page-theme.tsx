"use client";
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {normalizeAppearance,type EventAppearance} from '@/lib/event-appearance';
type ThemeContextValue={appearance:EventAppearance|null;apply:(owner:symbol,value:EventAppearance|null)=>void;clear:(owner:symbol)=>void};
const ThemeContext=createContext<ThemeContextValue>({appearance:null,apply:()=>{},clear:()=>{}});
export function EventThemeProvider({children}:{children:ReactNode}) {
  const [selected,setSelected]=useState<{owner:symbol;appearance:EventAppearance|null}|null>(null);
  const apply=useCallback((owner:symbol,appearance:EventAppearance|null)=>setSelected({owner,appearance}),[]);
  const clear=useCallback((owner:symbol)=>setSelected(current=>current?.owner===owner?null:current),[]);
  const value=useMemo(()=>({appearance:selected?.appearance??null,apply,clear}),[selected,apply,clear]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export function useEventPageAppearance(value:EventAppearance|null) {
  const {apply,clear}=useContext(ThemeContext),owner=useRef(Symbol('event-theme'));
  const signature=value?JSON.stringify(normalizeAppearance(value)):'';
  useEffect(()=>{apply(owner.current,signature?JSON.parse(signature):null);const id=owner.current;return()=>clear(id);},[signature,apply,clear]);
}
export function useActiveEventAppearance(){return useContext(ThemeContext).appearance;}
