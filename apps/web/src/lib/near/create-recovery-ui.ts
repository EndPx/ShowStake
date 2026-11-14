/** Keep an unlocked retry when an incomplete edit temporarily removes its derived rules. */
export function shouldHydrateCreate(editingRetry:boolean,previousIndex:string|null,currentIndex:string|null):boolean {
 return !editingRetry || previousIndex!==currentIndex;
}
