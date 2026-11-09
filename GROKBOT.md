# Set up your world with your grok bot

You do not need to know how to code. Copy everything in the box below and paste it into your grok bot as one message. It will do the work and ask you when it needs something.

Before you paste, change the two lines at the top of the box if you want to: your business name and the world you like.

The four worlds:

- `arctic-grid`: polar dusk, a frozen river, an orange vault. A team of 3.
- `hover-isles`: sunrise above the clouds, gold and cyan. A team of 3.
- `orbit-port`: space, a station over a glowing planet. A team of 4.
- `chrome-citadel`: bright daylight, white and silver. A team of 3.

Everyone who has your page can read what your bots post, so the bot is told to keep client names and private details out of it. Read the "Keep it public safe" part of the box. It matters.

---

```text
Set up my live bot world. Follow these steps in order. Do them yourself where you can, and stop and ask me only when you need something from me.

My business name: PUT YOUR NAME HERE
My island: orbit-port

Here is the project: https://github.com/echris6/grok-bot-worlds
Make my own copy of it first (a fork, or a clone pushed to a new repository of mine) and do all the work in that copy.

STEP 1. WRITE THE TEAM FILE
Look at every bot and scheduled job you run for me. Write public/config.json in the project, in this shape:

{
  "workspace": "my business name",
  "island": "orbit-port",
  "timezone": "America/New_York",
  "lead": { "id": "lead", "name": "lead", "role": "signs off what the line sends" },
  "bots": [
    { "id": "research", "name": "research", "role": "finds what buyers talk about", "color": "#3fd18b", "schedule": "mon, thu" },
    { "id": "writer", "name": "writer", "role": "turns it into drafts", "color": "#ff4d8d", "schedule": "tue, fri" },
    { "id": "inbox", "name": "inbox", "role": "sends the drafts and answers the replies", "color": "#ff7a2f", "schedule": "daily" }
  ]
}

Rules for this file:
- The team is a line of work. Put the "bots" entries in the order the work moves: first step first. The lead is the last step, where the work ends. The result of each step travels on the island to the next one, so the order has to be true to how the work really goes.
- A team is 3 or 4 counting the lead, so "bots" has 2 or 3 entries. Use the size my island is built for: orbit-port is 4, the others are 3. If I have more jobs than that, group them into steps and tell me how you grouped them. If I have fewer, add a helper that I would actually use and tell me.
- "id" is a short lowercase name with no spaces. It must never change, because every status update points at it.
- "color" is a colour like #3fd18b. Give each bot its own. Pick colours that are easy to tell apart. Leave white for the lead.
- "timezone" is my real time zone, like Europe/London. The island's day and night and the daily counts follow it.
- "role" and "schedule" are a few plain words, with nothing private in them.
- This file is public. No keys, no passwords, no client names.

STEP 2. CHECK IT WORKS IN DEMO MODE
Add "source": { "mode": "demo" } to the file for now. Run the project with npm install and npm run dev, open http://localhost:3260, and tell me what you see. If the page shows a list of problems, fix what it says.

STEP 3. CREATE THE EVENTS TABLE
I use Supabase for this. It is free for a project this size. If I do not have an account, walk me through making one and a new project just for this island, and give it nothing else.

Then make the write key:
1. Make a long random secret, 32 random bytes as hex. This is the WRITE KEY.
2. Save it in your own secret store. Call it ISLAND_WRITE_KEY.
3. Work out its sha256 hash, as lowercase hex.

Never show me the write key. Never put it in a file, a page, the config, a chat message, a log or a commit. The hash is fine to use in the next step.

Now take supabase/setup.sql from the project. In the function post_event, find the line that starts with "expected constant text" and put the hash where the placeholder is. Change nothing else. Give me the finished SQL, and tell me to open my Supabase project, go to SQL Editor, paste it and press Run. If you can run it yourself safely, do that instead.

Then ask me to copy the Project URL and the anon public key from Project Settings, then API. The anon key is meant to be public. If I give you anything labelled service_role or secret, tell me to take it back, do not use it, and ask for the anon key.

STEP 4. TEST THE WRITE AND THE LOCK
Using the Project URL and the anon key, check all of these:
- Sending an event with the right write key works.
- Sending one with a wrong write key is refused.
- Adding a row straight to the events table with only the anon key is refused.
- Reading the table with only the anon key works.
Send an event like this:

POST {Project URL}/rest/v1/rpc/post_event
Headers: apikey: {anon key}, Authorization: Bearer {anon key}, Content-Type: application/json
Body: {"write_key":"{ISLAND_WRITE_KEY}","bot_id":"research","type":"working","text":"setting up"}

If the anon key starts with sb_publishable_, leave out the Authorization header.

Tell me plainly which checks passed. If any failed, stop and tell me.

STEP 5. SWITCH THE PAGE TO LIVE
Change the source in public/config.json to:
"source": { "mode": "live", "url": "{Project URL}/rest/v1/events", "anon_key": "{anon key}" }

Only the anon key goes here, never the write key. Open the page and check that it says live in the corner and that your test event shows up.

STEP 6. SEND AN EVENT FOR EVERY JOB, FROM NOW ON
From now on, whenever any of my bots or jobs changes state, send one event the way step 4 shows. Add this to every job's instructions so it does not depend on you remembering:

- working: a job starts. Text says what it is doing in two to four words, like "writing drafts". On a long job, send another working every minute or so, with no text unless there is something new to say. The bot's bubble updates and its number ticks up. These count as the same job, not new ones.
- found: it finds something worth knowing. Add "value" with a number when there is one, like how many it found. Bigger numbers make a bigger moment on the island.
- done: it finishes. Text is the result in two to four words. The island sends the result along the line to the next bot, so when work really does pass on, send the next bot's working right after. This also clears any approval that this bot was waiting on, so send it after the approval is answered.
- needs_approval: it needs a yes from me before it can carry on. It stays up on the island until a later done from the same bot.
- idle: it has nothing to do until its next run.

"bot_id" must match an id in the config exactly. If a send fails, carry on with the job and try the next one. A status update must never stop real work. Never put the write key in the event.

KEEP IT PUBLIC SAFE
Anyone who has the page address can read every event. So:
- No client names, company names, people's names, emails, phone numbers, addresses, amounts tied to a person, order numbers, account details, links to private files, or anything from inside a message.
- Say what kind of thing happened, not who it was about. Write "a draft reply is ready to send", not "reply to Sarah at Acme about the refund". Write "3 new leads", not their names.
- Under 200 characters, one line.
- If you are not sure whether something is private, leave it out.
Check every event against this before you send it, every time, for every job.

STEP 7. PUT IT ONLINE
Run npm run build, then deploy the dist folder as a static site. The README explains Vercel and Netlify. Before you deploy, run npm run test:secrets, and if it reports anything, stop and fix it. Then give me the address.

STEP 8. TELL ME WHAT YOU DID
List the bots you added and their colours, what each one will send, and where the write key is kept (the name of the secret, never its value). Tell me how to turn writes off, which is to run setup.sql again with a new hash.
```

---

## If something looks wrong

- **The page shows a list of problems.** Paste that list to your grok bot. Each line says what to fix.
- **The corner says offline.** Your page cannot reach Supabase. It keeps trying on its own and shows why. Paste the message to your grok bot.
- **A bot's events do not show up.** The page says how many rows it skipped and why, right under the status. Most often the `bot_id` does not match the config.
- **You think the write key leaked.** Ask your grok bot to make a new one and run `setup.sql` again with the new hash. The old key stops working at once. Your events stay.
