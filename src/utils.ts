import { format } from 'date-fns'

export function friendlyDate(dateString: string, format_str?: string): string {
  const inputDate = new Date(dateString)
  return format(inputDate, format_str || 'do MMM yyyy')
}

export async function getJsonl(file: string) {
  const response = await fetch(file)
  return await (await response.text()).split('\n').map((post) => {
    return JSON.parse(post)
  })
}
