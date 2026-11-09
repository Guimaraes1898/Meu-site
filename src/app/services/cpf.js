export function normalizeCpf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function isValidCpf(value) {
  const cpf = normalizeCpf(value);

  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) {
    return false;
  }

  const checkDigit = (base) => {
    let sum = 0;
    for (let index = 0; index < base.length; index += 1) {
      sum += Number(base[index]) * (base.length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return (
    checkDigit(cpf.slice(0, 9)) === Number(cpf[9]) &&
    checkDigit(cpf.slice(0, 10)) === Number(cpf[10])
  );
}
