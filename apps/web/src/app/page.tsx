// Landing (home) page — adapted from CommitPass `apps/web/src/app/page.tsx`
// (baseline 542273df306a7e5887f1dfcabf1383e78930f579). EVM/Privy/Monad/yield
// copy, Cloudinary media, gas-sponsorship, faucet and session-gate references
// are removed. Illustrative artwork is native CSS and labelled sample.

import { ArrowUpRight, Check, Plus } from "lucide-react";
import { Brand } from "@/components/landing/brand";
import { Hero } from "@/components/landing/hero";
import { Walkthrough } from "@/components/landing/walkthrough";
import { Poster } from "@/components/landing/poster";
import { Reveal } from "@/components/landing/reveal";

const faqs = [
  {
    question: "Is the commitment a ticket price?",
    answer:
      "It’s a refundable deposit to reserve your spot. When your host confirms you attended and the event settles, you can claim it back. Each event sets its own deposit amount and attendance rules.",
  },
  {
    question: "What happens if I don’t show up?",
    answer:
      "In a normally settled event, your deposit is forfeited if you don’t attend, and it goes to the attendees who showed up. ShowStake takes no platform fee. Cancellation and zero-attendee cases follow their own refund rules.",
  },
  {
    question: "Where does the refund come from?",
    answer:
      "Your claim comes from the event’s escrow: your deposit, plus your share of the no-show deposits distributed to confirmed attendees. Settlement is deterministic and recorded on the NEAR contract — there is no yield or market return.",
  },
  {
    question: "Do I need to know anything about crypto?",
    answer:
      "You fund a NEAR account from a supported source chain, then your NEAR account commits a fixed FT deposit to the event escrow. The app shows exact amounts and your selected NEAR account as the pass and refund owner before you commit.",
  },
  {
    question: "Can I create or reserve an event now?",
    answer:
      "Event creation, deposits and settlement are not wired in this first frontend slice. The catalog is honestly empty until the ShowStake API and contract are connected. The posters and reservation previews on this page are illustrative examples.",
  },
  {
    question: "How is my attendance confirmed?",
    answer:
      "Your organizer scans your pass and records your check-in; the organizer’s signed on-chain acceptance finalizes attendance. A pass proves registration — not physical presence.",
  },
  {
    question: "What happens if the event is cancelled?",
    answer:
      "A confirmed cancellation, or a refund-only state after the finalization deadline, opens full-principal refund claims for every remaining registered participant.",
  },
];

export default function Home() {
  return (
    <div id="top">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Brand />
        <a className="button button--small" href="/discover">
          Explore events <ArrowUpRight size={16} />
        </a>
      </header>
      <main id="main">
        <Hero />
        <div className="promise-strip">
          <span>A spot saved.</span>
          <span className="strip-spark" aria-hidden="true">
            ✳
          </span>
          <span>A promise kept.</span>
          <span className="strip-spark" aria-hidden="true">
            ✳
          </span>
          <span>A little more together.</span>
        </div>
        <Walkthrough />
        <section
          className="host-section"
          id="for-hosts"
          aria-labelledby="host-title"
        >
          <div className="section host-inner">
            <Reveal className="host-art">
              <div className="host-poster">
                <Poster kind="dinner" />
              </div>
              <div className="guest-note">
                <div className="note-header">
                  <span>THE GUEST LIST</span>
                  <span className="sample-label">EXAMPLE</span>
                </div>
                <h3>
                  Set the table.
                  <br />
                  They’re coming.
                </h3>
                <div className="guest-row">
                  <span className="guest-avatar">A</span>
                  <div>
                    Alex<span>Commitment received</span>
                  </div>
                  <Check size={18} />
                </div>
                <div className="guest-row">
                  <span className="guest-avatar guest-avatar--rose">J</span>
                  <div>
                    Jamie<span>Commitment received</span>
                  </div>
                  <Check size={18} />
                </div>
                <div className="note-bottom">
                  <span className="status-dot" /> A little certainty feels good.
                </div>
              </div>
              <span className="handwritten">less chasing, more hosting.</span>
            </Reveal>
            <Reveal className="host-copy">
              <p className="eyebrow">FOR THE PEOPLE BRINGING PEOPLE TOGETHER</p>
              <h2 id="host-title">
                You bring the idea.
                <br />
                <em>
                  They bring the
                  <br className="desktop-break" /> commitment.
                </em>
              </h2>
              <p>
                Empty chairs shouldn’t be part of the plan. Give every RSVP a
                little meaning, so you can focus on making something worth
                showing up for.
              </p>
              <ul className="host-benefits">
                <li>
                  <Check size={18} /> Set a commitment that fits your community.
                </li>
                <li>
                  <Check size={18} /> Confirm who made it, all in one place.
                </li>
                <li>
                  <Check size={18} /> Let the on-chain rules handle settlement.
                </li>
              </ul>
              <a className="text-link" href="#questions">
                The details, without the fine-print feeling{" "}
                <ArrowUpRight size={17} />
              </a>
            </Reveal>
          </div>
        </section>
        <section
          className="section manifesto"
          aria-labelledby="manifesto-title"
        >
          <Reveal>
            <p className="eyebrow">OFFLINE IS WHERE IT HAPPENS</p>
            <h2 id="manifesto-title">
              The best part of any plan
              <br />
              is <em>the people who show up.</em>
            </h2>
            <p>
              For the first hellos. The one-more-coffees. The “same time next
              week?”s.
              <br className="desktop-break" /> A little commitment can make room
              for a lot more of that.
            </p>
            <div className="community-types">
              <span>Run clubs</span>
              <span>Supper clubs</span>
              <span>Workshops</span>
              <span>Meetups</span>
              <span>Your next good idea</span>
            </div>
            <figure className="community-figure">
              <div
                className="community-photo"
                role="img"
                aria-label="Illustrative sample artwork, created with native CSS"
              >
                <span className="community-photo-label" aria-hidden="true">
                  ShowStake <em>✳</em>
                </span>
              </div>
              <figcaption>
                <span>A little time together. A lot to take away.</span>
                <span>Illustrative sample · native CSS</span>
              </figcaption>
            </figure>
          </Reveal>
        </section>
        <section
          className="section faq-section"
          id="questions"
          aria-labelledby="faq-title"
        >
          <div>
            <p className="eyebrow">GLAD YOU ASKED</p>
            <h2 id="faq-title">
              A few
              <br />
              <em>good questions.</em>
            </h2>
          </div>
          <div className="faq-list">
            {faqs.map((faq) => (
              <details key={faq.question} name="showstake-faq">
                <summary>
                  {faq.question}
                  <Plus size={20} aria-hidden="true" />
                </summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="closing-area">
        <section className="closing">
          <Reveal>
            <p className="eyebrow">MAKE THE NEXT ONE COUNT</p>
            <h2>
              Less “maybe.”
              <br />
              <em>More memories.</em>
            </h2>
            <a className="button button--dark" href="/discover">
              Explore events <ArrowUpRight size={18} />
            </a>
            <p className="closing-note">Stake your spot. Show up.</p>
          </Reveal>
        </section>
        <div className="site-footer">
          <Brand compact />
          <span>Made for showing up.</span>
          <div>
            <span className="footer-status">
              <span className="status-dot" /> NEAR-centered event commitments ·
              local preview
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}