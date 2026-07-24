# Holiday Planner v5

A complete Netlify-hosted shared holiday planner for a new GitHub repository.

## Included

- Side navigation with Overview, Itinerary overview, Calendar, Itinerary breakdown, Bookings, Budget, Library, Travel Assistant and Settings.
- Editable day date and title, automatic date ordering and day renumbering.
- Calendar drag-and-drop date swapping plus earlier/later controls.
- Undo using an in-browser stack and Netlify Blob history snapshots.
- Shared authentication with administrator and read-only roles.
- Netlify Blobs persistence for trip data, users, history, images, research and assistant state.
- Persistent OpenAI conversation per trip.
- Read-only trip tools and background web research.
- Research fix: web search no longer uses unsupported `reasoning.effort: minimal`.

## Create the repository

1. Create a new empty GitHub repository.
2. Copy every file in this package into the repository root.
3. Commit and push.
4. Create a new Netlify project from that repository.
5. Add these environment variables in Netlify:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (for example `gpt-5-mini`)
   - Optional: `OPENAI_RESEARCH_MODEL`
6. Deploy.
7. On first visit, create the administrator account.

## Local development

```bash
npm install
npm run dev
```

Use Node.js 18 or later. Local data is sandboxed by Netlify Dev.
