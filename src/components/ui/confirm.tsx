"use client";

import { Button } from "./button";
import { Dialog } from "./overlay";

/** In-page confirmation. Native confirm() is avoided because embedded viewers block it. */
export function DiscardDialog({ open, onKeep, onDiscard, what = "your unsaved changes" }: { open: boolean; onKeep: () => void; onDiscard: () => void; what?: string }) {
  return (
    <Dialog
      open={open}
      onClose={onKeep}
      title="Discard unsaved changes?"
      description={`If you leave now, ${what} will be lost.`}
      footer={
        <>
          <Button onClick={onKeep}>Keep editing</Button>
          <Button variant="danger" onClick={onDiscard}>Discard</Button>
        </>
      }
    >
      <p className="text-sm text-muted">Saved notes and changes are not affected.</p>
    </Dialog>
  );
}
