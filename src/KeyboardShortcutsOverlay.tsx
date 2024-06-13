const KeyboardShortcutsOverlay = (props: any) => {
  const { onClose } = props;
  return (
  <div className="keyboard-shortcuts-overlay" onClick={onClose}>
    <div className="keyboard-shortcuts-content">
      <h2>Keyboard Shortcuts</h2>
      <ul>
        <li><strong>c</strong>: Toggle code owned or participated in PR visibility</li>
        <li><strong>d</strong>: Toggle dependabot PR visibility</li>
        <li><strong>m</strong>: Toggle showing PRs to master</li>
        <li><strong>\</strong>: Clear repo names to trigger refetching</li>
        <li><strong>?</strong>: Show this keyboard shortcuts overlay</li>
      </ul>
    </div>
  </div>
);
}

export default KeyboardShortcutsOverlay;
