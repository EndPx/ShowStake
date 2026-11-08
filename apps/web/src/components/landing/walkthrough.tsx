// Adapted from CommitPass `components/landing/walkthrough.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Mechanics preserved; copy changed
// to ShowStake's zero-fee / no-yield settlement (no-show funds go to attendees,
// never a platform cut). Provenance: docs/frontend-provenance.json.
"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  MapPin,
  Pause,
  Play,
  Ticket,
  Wallet,
} from "lucide-react";
import { Poster } from "./poster";

const steps = [
  {
    title: "Find your people.",
    body: "A run club, a workshop, a dinner with strangers. Save your spot with a small, refundable commitment.",
  },
  {
    title: "Make it out the door.",
    body: "Be there for the people who planned it. Check in at the event and let your host confirm your attendance.",
  },
  {
    title: "Your commitment comes back.",
    body: "After settlement, claim your commitment back. No-show deposits go to the attendees who showed up — ShowStake takes no fee.",
  },
];

export function Walkthrough() {
  const [step, setStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry?.isIntersecting ?? false),
      { threshold: 0.2 },
    );
    if (section.current) observer.observe(section.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isPlaying || !isVisible) return;
    const timer = window.setTimeout(() => {
      setStep((current) => (current + 1) % steps.length);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [step, isPlaying, isVisible]);

  return (
    <section
      ref={section}
      className="section walkthrough"
      id="how-it-works"
      aria-labelledby="how-title"
    >
      <div className="walkthrough-copy">
        <p className="eyebrow">A BETTER KIND OF RSVP</p>
        <h2 id="how-title">
          A small promise.
          <br />
          <em>A real connection.</em>
        </h2>
        <div className="step-list">
          {steps.map((item, index) => (
            <button
              type="button"
              key={item.title}
              className={`step-button${index === step ? " is-active" : ""}`}
              onClick={() => setStep(index)}
              aria-pressed={index === step}
              aria-controls="reservation-preview"
            >
              <span className="step-number">0{index + 1}</span>
              <span>
                <strong>{item.title}</strong>
                <span className="step-description">{item.body}</span>
              </span>
              <ArrowRight className="step-arrow" size={18} />
            </button>
          ))}
        </div>
        <button
          className="walkthrough-playback"
          type="button"
          onClick={() => setIsPlaying((playing) => !playing)}
          aria-label={
            isPlaying
              ? "Pause automatic walkthrough"
              : "Resume automatic walkthrough"
          }
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          {isPlaying ? "Pause preview" : "Resume preview"}
        </button>
      </div>
      <div className="walkthrough-art">
        <div className="preview-orbit orbit-one" />
        <div className="preview-orbit orbit-two" />
        <div className="reservation" id="reservation-preview">
          <div className="reservation-top">
            <span className="mini-brand">ShowStake.</span>
            <span className="sample-label">INTERACTIVE PREVIEW</span>
          </div>
          <div className="reservation-image">
            <Poster kind="run" compact />
            <div className="reservation-date">
              <span>SUN</span>
              <strong>12</strong>
            </div>
          </div>
          <div className="reservation-content">
            <span className="event-type">
              A LITTLE FRESH AIR, A LOT OF GOOD COMPANY
            </span>
            <h3>Sunday Slow Run</h3>
            <p className="event-location">
              <MapPin size={15} /> Jakarta · 7:00 AM
            </p>
            <div
              className="reservation-state"
              aria-live={isPlaying ? "off" : "polite"}
              aria-atomic="true"
              key={step}
            >
              <span className={`state-icon state-icon--${step}`}>
                {step === 0 ? (
                  <Ticket size={22} />
                ) : step === 1 ? (
                  <Check size={22} />
                ) : (
                  <Wallet size={22} />
                )}
              </span>
              <strong>
                {step === 0
                  ? "Your spot. Your promise."
                  : step === 1
                    ? "You made it!"
                    : "Your commitment, returned."}
              </strong>
              <p>
                {step === 0
                  ? "Refundable commitment (sample amount)"
                  : step === 1
                    ? "Attendance confirmed by your host"
                    : "Your commitment, returned after settlement"}
              </p>
              <span className="state-footnote">
                {step === 0
                  ? "Show up to become eligible for a refund."
                  : step === 1
                    ? "Next up: the event closes and settles."
                    : "No-show deposits go to attendees who showed up."}
              </span>
            </div>
            <button
              className="preview-button"
              onClick={() => setStep((current) => (current + 1) % steps.length)}
              type="button"
            >
              {step === 0
                ? "Preview check-in"
                : step === 1
                  ? "Preview settlement"
                  : "Start again"}
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
        <p className="preview-caption">
          An example of the journey. No payment is made.
        </p>
      </div>
    </section>
  );
}