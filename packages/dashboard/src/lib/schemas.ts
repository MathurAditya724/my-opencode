import { z } from "zod"

const urlString = z
  .string()
  .trim()
  .min(1, "URL is required")
  .transform((v) => v.replace(/\/+$/, ""))
  .refine((v) => {
    try {
      new URL(v)
      return true
    } catch {
      return false
    }
  }, "Invalid URL")

const optionalUrl = z
  .string()
  .trim()
  .transform((v) => v.replace(/\/+$/, ""))
  .refine((v) => {
    if (!v) return true
    try {
      new URL(v)
      return true
    } catch {
      return false
    }
  }, "Invalid URL")
  .transform((v) => v || undefined)

export const serverFormSchema = z.object({
  name: z.string().trim().optional().default(""),
  url: urlString,
  token: z.string().min(1, "Token is required"),
  opencodeUrl: optionalUrl.optional().default(""),
})

export type ServerFormValues = z.input<typeof serverFormSchema>
export type ServerFormOutput = z.output<typeof serverFormSchema>
