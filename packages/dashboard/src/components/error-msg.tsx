export function ErrorMsg({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive-foreground">
      {msg}
    </div>
  )
}
