import { CreateEventShell } from "@/components/event/lifecycle-panels";

// Event creation requires organizer sign-in + NEAR binding, which are not
// implemented in this slice. Show the path honestly rather than inventing a
// ready editor.
export default function NewEventPage() { return <main id="workspace-main" className="workspace-content lifecycle-workspace"><CreateEventShell /></main>; }
