# ShowStake submission copy

This is copy for the human-completed form and screenshot post, not a submitted application. The final submission pair is ShowStake + ProofBill, independently disclosed in both public READMEs. ProofBill replaces the previously planned Keyfolio entry.

## Form

| Field | Value or responsibility |
| --- | --- |
| Project name | ShowStake |
| Team lead | Albary |
| Email address | Human enters their contact email. |
| Team size | Human selects their actual team size. |
| Tracks | Open Innovation (`open`); NFTs That Do Something (`nfts`), preserving the user's selection in D014. Passes are custom and account-bound; no NEP-171/NEP-393 compatibility is claimed. |
| NEAR wallet address | Human enters the intended mainnet prize recipient. Do not substitute the contract address or assume the organizer wallet is the prize recipient. |
| Repository link | https://github.com/EndPx/ShowStake |
| Demo post link | Human publishes the screenshot post on X and uses that post's URL. The app URL is not the demo-post URL. |

## What did you build?

ShowStake helps event hosts reduce no-shows through fixed USDC attendance commitments. On NEAR, guests deposit exact amounts for account-bound passes, organizers sign QR-assisted attendance, and a Rust contract isolates each event's funds and calculates settlement and claims. We adapted our CommitPass frontend, added wallet-bound sessions and receipt verification, prepared NEAR Intents funding from Base USDC, and implemented Rhea supply/redeem accounting. The app and contract are deployed on mainnet; financial lifecycle evidence is from NEAR testnet, while funded mainnet and Rhea withdrawal verification remain open.

## X caption

```text
Empty seats waste real effort.

Built ShowStake at NEAR HACKATHON: USDC commitments, passes & attendance-based claims on NEAR.

Screenshots: mainnet UI + testnet evidence.

https://showstake.vercel.app
https://github.com/EndPx/ShowStake
@NEARProtocol #NEARHackathon
```

The caption is 249 characters when each URL is counted as 23 characters. The human checks the composer and publishes the post.

## Screenshot evidence

Use an actual ShowStake screenshot, such as `docs/readme/create-event.png`, as mainnet draft-editor evidence. For the financial result, capture the actual testnet settlement or attendee claim receipt below, preserving the testnet label, hash, receiver and execution details. The recorded run has five 2-Mock-USDC deposits, two attendees and three no-shows, with two 5-Mock-USDC claims. It is separate from the proposed two-person 0.1-USDC mainnet rehearsal.

Do not label presentation slides, dry quotes, hashless creation attempts or intended allocations as proof of a completed mainnet cycle.

Evidence: [testnet run](evidence/testnet-shared-s1114151743/result.json), [settlement](https://testnet.nearblocks.io/txns/EY9DgtDgVwR6UiHZoduGQZdJLFKvSL4AX31VJYUhRQD2), [attendee claim](https://testnet.nearblocks.io/txns/4t8CbduZtMTbe6uCUfr9e8C5HurH8PSqDuWbQTf5XV2X), [judge's guide](JUDGES.md).

Official instructions: https://nearhackathon.com/HACKATHON.md. Public X demo posts can attach screenshots; the local-only exception requires video when judges cannot open the demo. The repository remains public. No post or application is sent by preparing this document.
