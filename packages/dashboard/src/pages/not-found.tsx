import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { Link } from "react-router-dom"

export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <p className="text-6xl font-bold text-muted-foreground/30">404</p>
      <h1 className="mt-4 text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">The page you're looking for doesn't exist.</p>
      <Link to="/" className="mt-6">
        <Button variant="outline">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Button>
      </Link>
    </div>
  )
}
