export default function NotFound() {
  return (
    <main id="workspace-main" className="workspace-content">
      <div className="workspace-error" role="alert">
        <h2>That page doesn’t exist.</h2>
        <p>The page you’re looking for isn’t part of ShowStake yet.</p>
        <a className="button" href="/">
          Back to home
        </a>
      </div>
    </main>
  );
}