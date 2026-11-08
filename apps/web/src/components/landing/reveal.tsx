// Reused from CommitPass `components/landing/reveal.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Scroll reveal honours
// prefers-reduced-motion. Provenance: docs/frontend-provenance.json.
"use client";

import { useRef, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

export function Reveal({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(root.current, {
          y: 24,
          autoAlpha: 0,
          duration: 0.65,
          ease: "power2.out",
          scrollTrigger: {
            trigger: root.current,
            start: "top 92%",
            once: true,
          },
        });
      });
      return () => mm.revert();
    },
    { scope: root },
  );
  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}