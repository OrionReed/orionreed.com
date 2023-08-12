import { format } from 'date-fns'

export function friendlyDate(dateString: string): string {
  const inputDate = new Date(dateString)
  return format(inputDate, 'do MMM yyyy')
}

export async function getJsonl(file: string) {
  const response = await fetch('stream.jsonl')
  return await (await response.text()).split('\n').map((post) => {
    return JSON.parse(post)
  })
}
