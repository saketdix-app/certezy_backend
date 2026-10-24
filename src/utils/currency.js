import axios from 'axios'

// USD → INR (Razorpay ke liye)
export const convertUSDtoINR = async (usdAmount) => {
  try {
    const { data } = await axios.get('https://api.frankfurter.app/latest?from=USD&to=INR')
    const rate = data.rates.INR
    return Number((usdAmount * rate).toFixed(2))
  } catch (err) {
    const FALLBACK_RATE = 84.5
    return Number((usdAmount * FALLBACK_RATE).toFixed(2))
  }
}
