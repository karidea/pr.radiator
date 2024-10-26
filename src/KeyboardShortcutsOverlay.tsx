const KeyboardShortcutsOverlay = (props: any) => {
  const { onClose } = props;
  return (
  <div className="keyboard-shortcuts-overlay" onClick={onClose}>
    <div className="keyboard-shortcuts-content">
      <h2>Keyboard Shortcuts</h2>
      <ul>
        <li><strong>d</strong> : Toggle dependabot PR visibility</li>
        <li><strong>a</strong> : Toggle showing recent PRs to master</li>
        <li><strong>m</strong> : Toggle showing PRs to master</li>
        <li><strong>l</strong> : Toggle showing repository links</li>
        <li><strong>r</strong> : Triggers refresh of PRs</li>
        <li><strong>\</strong> : Clear repo names to trigger refetching</li>
        <li><strong>?</strong> : Show this keyboard shortcuts overlay</li>
      </ul>
    </div>
  </div>
);
}

export default KeyboardShortcutsOverlay;
