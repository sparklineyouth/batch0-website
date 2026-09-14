# Batch0 kickoff and promotion operations

Prepared September 14, 2026. This is an operator handoff, not evidence that every operational checkbox is complete. Check runtime status, live database records, and delivered-message logs before marking anything done.

## Decision: spend $0 on new ads for this kickoff

Protect the students already joining. The immediate bottleneck is a reliable event, access, useful course material, and responsive support. A new cold-traffic campaign hours before kickoff has no demonstrated acquisition economics or guaranteed delivery window. That is a judgment about this launch, not a claim that advertising can never work.

Google says most ads are reviewed within one business day and some take longer. It recommends submitting several days ahead for a specific start date. Ads created today cannot be counted on to fill tonight's session. [Google ad review process](https://support.google.com/google-ads/answer/1722120)

An average daily budget can spend up to twice that amount on a day for most campaigns. Google now supports campaign total budgets for new Search campaigns and several other formats, with a fixed campaign cap. Do not treat `$5/day for four days` as a $20 lifetime cap. [Average daily spending](https://support.google.com/google-ads/answer/1704443?hl=en), [campaign total budgets](https://support.google.com/google-ads/answer/10486938?hl=en), [supported formats](https://support.google.com/google-ads/answer/15137812?hl=en)

If a future paid experiment is approved, use one Search campaign with a real total budget and start/end dates, a narrow relevant keyword group, and a tested application conversion. Keep the campaign paused until the budget owner approves the exact total. No retargeting or student-list uploads: this product serves minors and its privacy policy says analytics is not used to build advertising profiles. Google also disables personalized advertising for known under-18 accounts. [Google teen protections](https://support.google.com/adspolicy/answer/12205906?hl=en)

Measure cost per **paid enrollment**, with application and acceptance conversion rates as separate steps. A $5 email signup is not a $5 customer. Break-even maximum acquisition cost must be below collected tuition minus payment fees, refunds, support time, and delivery costs. No profitable CAC target can honestly be declared from tuition alone.

## What is implemented in this change

- `/start`: substantial ungated founder starter kit, with five exercises, concrete examples, evidence checks, and 13 relevant existing public guides.
- `/resources/founder-starter-worksheet.txt`: complete reusable worksheet, interview notes, experiment and outcome log, distribution/pricing prompts, pitch template, and a seven-day action plan.
- Copy, download, and native share controls, with visible recovery messages if clipboard or sharing is unavailable. Worksheet answers are never collected by this page.
- Dedicated social preview, canonical metadata, free learning-resource structured data, sitemap entry, and public static route handling.
- Paths to the program, application/dashboard, parent FAQ, enrolled course, and events. Pricing comes from site configuration; the public kit does not invent dates or deadlines.
- `starter_kit_action` analytics events for copy, download, and share controls, using the existing Vercel Analytics integration. These measure control actions, not whether someone completed a worksheet.
- Reusable promotion copy in `content/promotion/ready-to-publish.md` and a channel/UTM map in `content/promotion/channel-plan.csv`.
- Corrected the existing paid-ads guide's budget-cap advice, lead/CAC confusion, minor-targeting advice, and obsolete four-week program language.

The website package must be deployed and smoke-tested before `/start` links are distributed. Drafts are not sent messages. No new ad account, billing change, campaign, or spend was created by this work.

## Use existing distribution before adding tools

| Priority | Action | Why it fits | Measurement |
| --- | --- | --- | --- |
| 1 | Link the free kit from the website and existing guides | Gives visitors a useful first action without a new account or budget | Starter-kit controls, visits, application submissions |
| 2 | Let enrolled students voluntarily use existing personal referral links | The referral feature already carries codes across signup and stores them on applications | `/admin/referrals`: accepted and enrolled applications |
| 3 | Publish one real founder post showing the working kit | Uses an existing relationship and a visible product | Channel UTM visits and relevant replies |
| 4 | Share the resource with known educators/club advisors | A practical lesson resource is easier to recommend than an unfamiliar paid program | Replies and genuine sharing |
| 5 | Post once in a relevant community's permitted resources channel | Reaches students already trying to build | Useful conversations and qualified applications |

Do not create ten accounts, spray unsolicited messages, or buy followers. Accounts and recipient lists were not verified in this package. Copy is prepared for the owner to publish or explicitly authorize on a known destination.

## Attribution and interpretation

Use the links in the channel CSV. `utm_source` is the channel, `utm_medium` is the delivery method, `utm_campaign=founder_starter_kit` identifies this resource. Do not add student names, emails, phone numbers, or application answers to URLs.

The repo already sends production page views to GA4 (`G-C51DMRB6YE`) and uses Vercel Analytics for `apply_click` and `application_submitted`. The starter kit adds action events without another provider. UTM-tagged arrival pages can support channel reports in GA4, subject to browser blocking and account configuration. Vercel action events do not, by themselves, prove application-to-source attribution. An instrumented code path is not proof that the analytics account is receiving data: confirm a permitted test visit and event in the live dashboards.

The referral path is stronger for attribution to actual applications: real `ref` codes are captured through the auth funnel and stored in `applications.referral_code`. Campaign UTMs do not create student referral credit. Do not invent campaign referral codes or promise incentives that are not configured.

Track daily: eligible site visits, kit actions, applications submitted, applications accepted, paid/enrolled students, refund requests, and total cash spent. Compare rates only when sample sizes are meaningful. Stop promotion if the application or payment flow is broken.

## Kickoff operator checklist

The live event was checked through the database and Daily read APIs on September 14: **Monday, September 14, 2026, 8:00–9:00 p.m. U.S. Eastern (EDT)**. The student/host entry point is `/dashboard/events/1bbfd694-24be-4c83-a450-ff85c06716a0/live`; the join window opens at **7:45 p.m. EDT**. The event is enrolled-only, and its Daily room is private with owner-only broadcast. This is a configuration check, not evidence that a human successfully joined or tested audio. Recheck the event if its schedule changes.

### Human host actions that the setup cannot perform

- [ ] Rishabh and Shresht agree who presents and who watches the private Q&A/support inbox. Both currently have an admin role with `events.manage`; each must sign in to their own staff account. A staff title or display name alone does not grant host controls.
- [ ] By 7:30 p.m., open the lesson/worksheet and test the intended microphone, camera, headphones, screen share, network, and any local recorder. The actual event rejects **hosts and students alike** before 7:45; do device checks before that.
- [ ] At 7:45 p.m., open the event through Batch0, confirm the prejoin screen says host, choose camera/mic settings, and click **Start**. Verify the live header says **Hosting**. The cohost should independently verify sound and the shared lesson.
- [ ] One enrolled student tests **Join**, sound, and the separate Q&A panel. Do not send raw Daily room URLs or host tokens; students need the Batch0 page to receive their own authorized token.
- [ ] At 8:00 p.m., tell students: “Your camera and mic are off. Type your problem, answers, and questions in the Q&A beside the video; only staff can see them.” Read selected responses aloud without exposing private details or opening the staff queue on a shared screen.

**This is a broadcast workshop.** Viewer tokens have `hasPresence: false`; students cannot broadcast audio/video, cannot post in Daily chat, and cannot see other students' questions or the audience roster. The participant panel is not a reliable student attendance list because viewers are hidden. Ask for a brief “here + one problem” Q&A response and keep a private attendance note, while recognizing that a silent attendee may still be watching. Do not plan open-mic introductions, breakouts, or peer discussion in this room. Do not grant students `events.manage` to get microphones working; that is an administrative permission. A different interactive format requires a separately tested, moderated meeting setup.

### Recording and recap

The inspected room has **no recording enabled**, and the environment does not enable Daily cloud recording. The deployed live page uses Daily Prebuilt; it does not implement local capture or automatically publish recordings. A record-looking control elsewhere in the repository is not proof that this room records. Do not add a payment method or enable cloud recording just to make a promised replay appear.

- [ ] Decide before the session whether a replay is needed. If using an already-tested local recorder, verify that its saved file captures the intended screen and microphone/audio; the assistant cannot start or supervise that recording for the host.
- [ ] Explain the recording plan before starting, confirm the program's permission/consent arrangements, and provide a way to contribute without identifying a student in the replay. Capture the teaching screen; keep private Q&A, enrollment lists, support messages, and payment details out of frame. Pause before sensitive discussions.
- [ ] Stop and save the recording deliberately; play the actual file to verify intelligible audio before promising a replay. Review/redact it, restrict access to the cohort, then add the approved link to the event. `recording_url` is a link field; it does not upload, record, or make a public hosting URL private.
- [ ] If no usable recording exists, publish the lesson, worksheet, worked example, and concise written recap. State that these are the catch-up materials; do not claim a recording will arrive automatically.

### Recipient and withdrawal check before any reminder

No new reminder, email, Discord post, or scheduled send is authorized by this checklist. The prepared drafts stay unsent until the owner approves the actual audience and message.

- [ ] Start with the **current cohort's enrollment roster**, then review pending withdrawal/refund/support conversations separately. A person can request withdrawal by email while their database status still looks enrolled. The read snapshot found no withdrawn application among the current enrolled rows, which does not resolve those conversations.
- [ ] Exclude withdrawn students and anyone explicitly asking to stop participation/contact from kickoff and promotional batches. Resolve ambiguous access/payment cases individually; do not promise enrolled access to accepted-but-unpaid applicants.
- [ ] Review already-pending outbox entries for the excluded people, including retries and parent-address copies. Existing queue gates check payment, enrollment, application decisions, or login; they do **not** provide a general withdrawal/refund-request exclusion. Parent-only queue rows may also bypass person-based conditions.
- [ ] Keep the event editor's **Notify** option off while editing. Its notify path sends enrolled-student emails and a Discord post on each save; it does not provide a separate deduplicated kickoff campaign or automatically suppress pending withdrawal requests. Saving again can send again.
- [ ] Once a specific send is approved, use one reviewed recipient list, one exact event link, and the explicit time zone. Check delivery failures/bounces and avoid resending to everyone just because one recipient needs help.

### Refund follow-up

Assign one operator to each unresolved request and inspect the matching application, original payment, refund history, amount, and existing reply. Keep names and case details in the private admin system. Do not infer that silence means the request is resolved, or make the student attend kickoff to get support.

The current **Refund latest payment** action refunds the most recent succeeded payment, removes its enrollment, and sets its application back to **accepted**. It does not mean “withdraw this student permanently” and can leave the person eligible for payment reminders. The separate removal action marks the latest application withdrawn, removes enrollments, and sends its own removal email. Neither action should be used as a shortcut for editing a reminder list. A refund/withdrawal requires the correct case decision and authorization; afterward, verify enrollment, application status, queued reminders, and the student's acknowledgement separately.

### Before inviting anyone

- [ ] Correct active cohort, calendar dates, enrollment list, payment/access status, and application close state verified in production.
- [ ] Kickoff event exists with exact date/time/time zone, duration, host, access visibility, and tested join link.
- [ ] Host has opened the room; one enrolled account has successfully joined. A logged-out or unenrolled account cannot enter a private session.
- [ ] If hosting is built in, the configured provider, required migrations, permissions, capacity, and microphone/screen-share behavior work. If using an external room, test the actual external link.
- [ ] Published course modules and lessons are visible from an enrolled account; exercises/resources download; lesson completion works; first-session route is obvious.
- [ ] Parent/support contact is reachable and one real person is assigned to monitor it during kickoff.
- [ ] Existing refund and access requests are individually reviewed before sending cheerful launch messages to affected people. Do not issue a refund without the correct charge, amount, and authorization.
- [ ] Any mentor/guest named in the schedule has actually confirmed. No promised speaker, office-hour slot, recording, or grant is invented.

### Relative to the verified start time

| Time | Operator action | Done when |
| --- | --- | --- |
| T−60 min | Confirm attendance roster; open course and event on a second device; inspect outstanding access issues | A student can reach the first lesson and room |
| T−30 min | Host/cohost audio, screen share, display name, permissions, and backup connection check | Both people can carry the session |
| T−15 min | Open the room; show a welcome slide with agenda and support contact | Students have somewhere to arrive |
| T−5 min | Admit/assist students, collect questions, verify attendance privately | Late/blocked students have a named support person |
| Start | Welcome; explain the program rhythm, behavior expectations, where work lives, and today's result | Every student can find the course and knows the next step |
| First 10 min | Each student names a problem; use the worksheet to separate observations from assumptions | Every student has a starting problem, not a polished pitch |
| Middle | Work through one short validation exercise and show a real example | Students produce something during the session |
| Final 10 min | Have students choose a first conversation/test and a deadline; answer questions | Each student leaves with a concrete next action |
| T+15 min | Post a concise recap, next steps, and verified next event; link a recording only if one exists and sharing is appropriate | Students who missed the session can catch up |

This is a suggested run-of-show, not a claim about a meeting duration or a promise that the platform records automatically. Keep the actual session inside the scheduled time.

## Verification record

Code and link checks are recorded in the task handoff. Production smoke testing remains a separate check after deployment. A narrow search of connected Gmail for Batch0 kickoff/orientation/meeting terms from Aug 1–Sep 15 did not find a matching logistics email; a primary-calendar Batch0 search for Sep 13–16 found a work block and no kickoff event. Those searches are incomplete evidence, so inspect the live platform event list rather than treating the absence as proof that no event exists.

No private student identities, contact details, refunds, or meeting secrets belong in this public repository document. Keep operational case details in the private admin system.
