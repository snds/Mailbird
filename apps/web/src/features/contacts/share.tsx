import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import type { ContactDetail } from "@/core/types"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/** Share a card: the system share sheet where there is one, a .vcf file, or a QR code to scan. */
export function ShareContact({ contact, className }: { contact: ContactDetail; className: string }) {
  const [qr, setQr] = useState<string | null>(null)
  // Phones (and some desktops) can hand a file to the share sheet: Messages, AirDrop, Nearby Share.
  const canShareFiles = typeof navigator !== "undefined" && typeof navigator.canShare === "function"
  const shareSheet = async () => {
    const { fileName, vcf } = await (await getCoreClient()).contactVcard(contact.id)
    const file = new File([vcf], fileName, { type: "text/vcard" })
    if (!navigator.canShare?.({ files: [file] })) return void toast.error("This device can't share files. Save the card instead.")
    await navigator.share({ files: [file], title: contact.fullName }).catch((e: unknown) => {
      // Closing the share sheet isn't an error.
      if (!(e instanceof DOMException && e.name === "AbortError")) throw e
    })
  }
  const save = async () => toast.success(`Saved to ${await (await getCoreClient()).saveContactVcard(contact.id)}`, { duration: 3000 })
  const showQr = async () => setQr(await (await getCoreClient()).contactQr(contact.id))
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="secondary" className={className} />}>
          <Icon name="ios_share" className="size-5" />
          Share
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {canShareFiles && (
            <DropdownMenuItem onClick={() => void shareSheet().catch(fail)}>
              <Icon name="share" /> Share…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void save().catch(fail)}>
            <Icon name="download" /> Save as vCard file
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void showQr().catch(fail)}>
            <Icon name="qr_code_2" /> Show QR code
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={qr !== null} onOpenChange={(o) => !o && setQr(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{contact.fullName}</DialogTitle>
            <DialogDescription>Scan with a phone's camera to add this contact. It carries the name, company, title, phones, and emails.</DialogDescription>
          </DialogHeader>
          {qr && (
            // An image, not inline markup: the SVG never runs in the page.
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`}
              alt={`QR code for ${contact.fullName}`}
              className="mx-auto aspect-square w-full max-w-64 rounded-lg bg-white p-2"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
