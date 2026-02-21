# Linear-Manus Bridge

## Middleware Service to Assign Linear Issues to Manus via API

This project aims to create a lightweight middleware service that acts as a translator between Linear and Manus, enabling the assignment of Linear issues to Manus for automated task execution.

## Architecture Overview

The service will follow a three-component architecture:

1.  **The Linear Setup (The Trigger)**
    *   Create a "fake user" inside Linear.
    *   Go to Linear's Developer settings and create a new OAuth Application.
    *   Request `app:assignable` and `app:mentionable` scopes so the bot can be assigned to tickets.
    *   Enable webhooks specifically for Agent session events. This tells Linear to ping your server the moment someone assigns a ticket to your new "@Manus" bot.

2.  **The Middleware (The Bridge)**
    *   Host a backend service (in Python, Node.js, etc.) to listen for Linear webhooks.
    *   When a user assigns a ticket to the bot, Linear sends a JSON payload to your server containing the issue ID, title, description, and any comments.
    *   Your middleware parses this data and packages it into a prompt.

3.  **The Manus API (The Execution)**
    *   Your middleware then takes that packaged prompt and makes an API call to Manus.
    *   You will hit the Manus API (typically `POST /v1/tasks`).
    *   You pass the Linear issue details as the instructions (e.g., "Fix the database routing bug described here: [Description].").
    *   Manus spins up its sandboxed environment, writes the code, and completes the task.

4.  **The Callback (The Update)**
    *   Manus processes tasks asynchronously. Once Manus finishes the job, it will trigger a webhook back to your middleware with the results.
    *   Your middleware then takes that output, formats it, and uses the Linear GraphQL API to post a comment on the original issue (e.g., "I have completed this task and opened PR #123") and update the issue status to "In Review" or "Done."
