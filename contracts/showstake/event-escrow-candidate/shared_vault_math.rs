//! Checked floor(a*b/d) with a full 256-bit intermediate.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let (mut hi, mut lo) = (0u128, 0u128);
    let (mut xhi, mut xlo) = (0u128, a);
    for i in 0..128 {
        if (b >> i) & 1 != 0 {
            let (n, carry) = lo.overflowing_add(xlo);
            lo = n;
            hi = hi.checked_add(xhi)?.checked_add(carry as u128)?;
        }
        xhi = (xhi << 1) | (xlo >> 127);
        xlo <<= 1;
    }
    let mut rem = 0u128;
    let mut result = 0u128;
    for i in (0..256).rev() {
        let bit = if i >= 128 {
            (hi >> (i - 128)) & 1
        } else {
            (lo >> i) & 1
        };
        let carry = rem >> 127;
        rem = (rem << 1) | bit;
        if carry != 0 || rem >= d {
            rem = rem.wrapping_sub(d);
            if i >= 128 {
                return None;
            }
            result |= 1u128 << i;
        }
    }
    Some(result)
}

/// Exclude quarantined provider shares before converting internal units to FT atomics.
pub fn owned_value(
    internal_balance: u128,
    physical_shares: u128,
    quarantined: u128,
    scale: u128,
) -> Option<u128> {
    if scale == 0 || quarantined > physical_shares {
        return None;
    }
    if physical_shares == 0 {
        return if internal_balance == 0 { Some(0) } else { None };
    }
    Some(
        mul_div(
            internal_balance,
            physical_shares - quarantined,
            physical_shares,
        )? / scale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_width_and_overflow() {
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        assert_eq!(mul_div(u128::MAX, u128::MAX, 1), None);
        assert_eq!(mul_div(11, 7, 3), Some(25));
        assert_eq!(mul_div(1, 1, 0), None);
    }
    #[test]
    fn quarantine_excludes_gain_before_internal_scale_rounding() {
        let scale = 1_000_000_000_000u128;
        assert_eq!(owned_value(3 * scale, 3, 1, scale), Some(2));
        assert_eq!(owned_value(3 * scale - 1, 3, 1, scale), Some(1));
        assert_eq!(owned_value(2 * scale + 1, 2, 1, scale), Some(1));
        assert_eq!(owned_value(50 * scale, 1, 1, scale), Some(0));
        assert_eq!(owned_value(scale, 1, 2, scale), None);
    }
}
