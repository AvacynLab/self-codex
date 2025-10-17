export function usedHelper(): number {
  return 42;
}

const internalValue = usedHelper();
export { internalValue };
