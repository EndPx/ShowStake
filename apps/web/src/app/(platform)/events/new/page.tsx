import { CatalogUnavailable } from "@/components/event/event-list-states";

// Event creation requires organizer sign-in + NEAR binding, which are not
// implemented in this slice. Show the path honestly rather than inventing a
// ready editor.
export default function NewEventPage() {
  return (
    <main id="workspace-main" className="workspace-content">
      <CatalogUnavailable
        title="Event creation is coming soon."
        description="Creating an event requires signed-in organizer identity and a NEAR account binding, which are not wired in this first frontend slice. Nothing here can be submitted yet."
      />
    </main>
  );
}