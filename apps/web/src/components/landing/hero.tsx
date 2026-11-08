// Adapted from CommitPass `components/landing/hero.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Scroll-pin poster assembly and
// reduced-motion honoured; branding and copy rebranded to ShowStake. External
// demo/video links and the @commitpass/shared import are removed.
"use client";

import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { ArrowDown, ArrowUpRight, Check, MapPin } from "lucide-react";
import { Poster, posters } from "./poster";

gsap.registerPlugin(ScrollTrigger, useGSAP);

export function Hero() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        "(min-width: 900px) and (min-height: 700px) and (prefers-reduced-motion: no-preference)",
        () => {
          const stage = root.current!;
          const cards = gsap.utils.toArray<HTMLElement>(
            ".floating-poster",
            stage,
          );
          const timeline = gsap.timeline({
            defaults: { ease: "power2.inOut" },
            scrollTrigger: {
              trigger: stage,
              start: "top 80px",
              end: "+=110%",
              pin: true,
              scrub: 0.8,
              invalidateOnRefresh: true,
            },
          });
          timeline
            .to(
              ".hero-copy, .hero-bottom",
              { y: -60, autoAlpha: 0, duration: 0.35 },
              0,
            )
            .to(
              cards,
              {
                x: (_, element: HTMLElement) =>
                  (stage.clientWidth - element.offsetWidth) / 2 -
                  element.offsetLeft,
                y: (_, element: HTMLElement) =>
                  (stage.clientHeight - element.offsetHeight) / 2 -
                  element.offsetTop,
                rotation: (index) => (index - 2.5) * 4,
                scale: 0.8,
                duration: 0.75,
                stagger: 0.025,
              },
              0.05,
            )
            .to(cards, { autoAlpha: 0, scale: 0.65, duration: 0.25 }, 0.72)
            .fromTo(
              ".gathered-pass",
              { autoAlpha: 0, y: 48, scale: 0.9 },
              { autoAlpha: 1, y: 0, scale: 1, duration: 0.45 },
              0.72,
            )
            .fromTo(
              ".gathered-heading",
              { autoAlpha: 0, y: 24 },
              { autoAlpha: 1, y: 0, duration: 0.35 },
              0.9,
            )
            .to({}, { duration: 0.2 });
          return () => timeline.revert();
        },
      );
      mm.add(
        "(max-width: 899px) and (prefers-reduced-motion: no-preference), (max-height: 699px) and (prefers-reduced-motion: no-preference)",
        () => {
          const stage = root.current!;
          const cards = gsap.utils
            .toArray<HTMLElement>(".floating-poster", stage)
            .filter((card) => getComputedStyle(card).display !== "none");
          const pass = stage.querySelector<HTMLElement>(".gathered-pass")!;
          const timeline = gsap.timeline({
            defaults: { ease: "power2.inOut" },
            scrollTrigger: {
              trigger: stage,
              start: "top top",
              end: "top -15%",
              scrub: 0.5,
              invalidateOnRefresh: true,
            },
          });
          timeline
            .to(
              ".hero-copy, .hero-bottom",
              { y: -24, autoAlpha: 0, duration: 0.35 },
              0,
            )
            .to(
              cards,
              {
                x: (_, card: HTMLElement) =>
                  (stage.clientWidth - card.offsetWidth) / 2 - card.offsetLeft,
                y: (_, card: HTMLElement) => {
                  return (
                    stage.querySelector<HTMLElement>(".gathered")!.offsetTop +
                    pass.offsetTop +
                    (pass.offsetHeight - card.offsetHeight) / 2 -
                    card.offsetTop
                  );
                },
                rotation: (index) => (index - 1) * 4,
                scale: 0.8,
                duration: 0.75,
                stagger: 0.03,
              },
              0,
            )
            .to(cards, { autoAlpha: 0, scale: 0.65, duration: 0.25 }, 0.65)
            .fromTo(
              pass,
              { autoAlpha: 0, y: 24, scale: 0.94 },
              { autoAlpha: 1, y: 0, scale: 1, duration: 0.4 },
              0.65,
            );
          return () => timeline.revert();
        },
      );
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section className="hero" ref={root} aria-labelledby="hero-title">
      <div className="hero-glow" aria-hidden="true" />
      <div className="poster-constellation" aria-hidden="true">
        {posters.map((poster, index) => (
          <div
            className={`floating-poster floating-poster--${index + 1}`}
            key={poster.kind}
          >
            <div className="poster-idle">
              <Poster kind={poster.kind} />
            </div>
          </div>
        ))}
      </div>
      <div className="hero-copy">
        <p className="eyebrow">
          <span className="little-star" aria-hidden="true">
            ✳
          </span>{" "}
          YOUR PRESENCE SHOULD MEAN SOMETHING.
        </p>
        <h1 id="hero-title">
          Stake your spot.
          <br />
          <em>Show up.</em>
        </h1>
        <p className="hero-description">
          Publish an event. Reserve a spot with a refundable deposit.
          <br className="desktop-break" /> Show up — then claim it back after
          the event settles.
        </p>
        <div className="hero-actions">
          <a href="/discover" className="button button--dark">
            Explore events <ArrowUpRight size={18} />
          </a>
          <a href="#how-it-works" className="text-link">
            How it works <ArrowUpRight size={16} />
          </a>
        </div>
      </div>
      <div className="hero-bottom">
        <span>FOR THE PEOPLE WHO SHOW UP</span>
        <a href="#how-it-works" aria-label="Scroll to how ShowStake works">
          <ArrowDown size={18} />
        </a>
        <span>A SPOT YOU MEAN</span>
      </div>
      <div className="gathered" aria-hidden="true">
        <div className="gathered-heading">
          <p className="eyebrow">A LITTLE COMMITMENT GOES A LONG WAY</p>
          <h2>
            Your next “I’m in.”
            <br />
            <em>Now means something.</em>
          </h2>
        </div>
        <div className="gathered-pass">
          <div className="pass-cover">
            <Poster kind="run" compact />
            <div>
              <span className="sample-label">EXAMPLE RESERVATION</span>
              <h3>Sunday Slow Run</h3>
              <p>
                <MapPin size={14} /> Jakarta, with your people
              </p>
            </div>
          </div>
          <div className="pass-divider" />
          <div className="pass-row">
            <span>Example commitment</span>
            <strong>5.00</strong>
          </div>
          <div className="pass-confirm">
            <span className="check-disc">
              <Check size={18} />
            </span>
            <div>
              <strong>You bring yourself.</strong>
              <span>
                Your deposit is returned after your host confirms attendance and
                the event settles.
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}