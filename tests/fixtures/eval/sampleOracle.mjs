export function validate({ transcript }) {
  if (!/oracle/.test(transcript)) {
    throw new Error("transcript ne contient pas oracle");
  }
}
