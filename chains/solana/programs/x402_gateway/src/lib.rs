#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::Instruction,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::instruction as system_instruction;

solana_program::declare_id!("6F2rv4dbwJ7A3F9Q8NpL6X2kYQ6Zxj2Y8ywmupfHP2aG");

pub const STATE_SIZE: usize = 8 + 32 + 32 + 32;
pub const STATE_DISCRIMINATOR: [u8; 8] = [0x78, 0x34, 0x30, 0x32, 0x5f, 0x73, 0x6d, 0x74];
pub const PROOF_LEN: usize = 388;
pub const WITNESS_LEN: usize = 76;
pub const PAY_AUTHORIZED_HEADER_LEN: usize = 32 + 8 + 8; // auth_id + amount + auth_expiry
pub const PAY_AUTHORIZED_DATA_LEN: usize = PAY_AUTHORIZED_HEADER_LEN + PROOF_LEN + WITNESS_LEN;

pub mod instruction {
    pub const INITIALIZE_STATE: u8 = 0;
    pub const SET_SMT_ROOT: u8 = 1;
    pub const PAY_AUTHORIZED: u8 = 2;
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum GatewayError {
    InvalidDataLength = 0,
    InvalidStateAccount = 1,
    SmtRootMismatch = 2,
    InvalidStatePda = 3,
    InvalidZkVerifier = 4,
    AuthorizationExpired = 5,
}

impl From<GatewayError> for ProgramError {
    fn from(e: GatewayError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match instruction_data[0] {
        instruction::INITIALIZE_STATE => {
            process_initialize(program_id, accounts, &instruction_data[1..])
        }
        instruction::SET_SMT_ROOT => {
            process_set_smt_root(program_id, accounts, &instruction_data[1..])
        }
        instruction::PAY_AUTHORIZED => {
            process_pay_authorized(program_id, accounts, &instruction_data[1..])
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    init_data: &[u8],
) -> ProgramResult {
    if init_data.len() != 32 {
        return Err(GatewayError::InvalidDataLength.into());
    }

    let account_iter = &mut accounts.iter();
    let admin = next_account_info(account_iter)?;
    let state_account = next_account_info(account_iter)?;
    let system_program = next_account_info(account_iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (state_pda, bump) =
        Pubkey::find_program_address(&[b"state", admin.key.as_ref()], program_id);
    if state_account.key != &state_pda {
        return Err(GatewayError::InvalidStatePda.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(STATE_SIZE);
    let signer_seeds: &[&[u8]] = &[b"state", admin.key.as_ref(), &[bump]];

    solana_program::program::invoke_signed(
        &system_instruction::create_account(
            admin.key,
            state_account.key,
            lamports,
            STATE_SIZE as u64,
            program_id,
        ),
        &[admin.clone(), state_account.clone(), system_program.clone()],
        &[signer_seeds],
    )?;

    let mut state_data = state_account.try_borrow_mut_data()?;
    state_data[0..8].copy_from_slice(&STATE_DISCRIMINATOR);
    state_data[8..40].copy_from_slice(admin.key.as_ref());
    state_data[40..72].copy_from_slice(&[0u8; 32]); // smt_root
    state_data[72..104].copy_from_slice(init_data);

    Ok(())
}

fn process_set_smt_root(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() != 32 {
        return Err(GatewayError::InvalidDataLength.into());
    }

    let account_iter = &mut accounts.iter();
    let admin = next_account_info(account_iter)?;
    let state_account = next_account_info(account_iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (state_pda, _bump) =
        Pubkey::find_program_address(&[b"state", admin.key.as_ref()], program_id);
    if state_account.key != &state_pda {
        return Err(GatewayError::InvalidStatePda.into());
    }

    let mut state_data = state_account.try_borrow_mut_data()?;
    if state_data[0..8] != STATE_DISCRIMINATOR {
        return Err(GatewayError::InvalidStateAccount.into());
    }

    state_data[40..72].copy_from_slice(data);
    Ok(())
}

fn process_pay_authorized(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() != PAY_AUTHORIZED_DATA_LEN {
        msg!("invalid PayAuthorized data len: {}", data.len());
        return Err(GatewayError::InvalidDataLength.into());
    }

    let account_iter = &mut accounts.iter();
    let payer = next_account_info(account_iter)?;
    let recipient = next_account_info(account_iter)?;
    let state_account = next_account_info(account_iter)?;
    let zk_verifier = next_account_info(account_iter)?;
    let system_program = next_account_info(account_iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let state_data = state_account.try_borrow_data()?;
    if state_data[0..8] != STATE_DISCRIMINATOR {
        return Err(GatewayError::InvalidStateAccount.into());
    }
    let configured_verifier = Pubkey::new_from_array(state_data[72..104].try_into().unwrap());
    if zk_verifier.key != &configured_verifier {
        return Err(GatewayError::InvalidZkVerifier.into());
    }

    let amount = u64::from_le_bytes(data[32..40].try_into().unwrap());
    let auth_expiry = u64::from_le_bytes(data[40..48].try_into().unwrap());

    let now = Clock::get()?.unix_timestamp;
    if now > auth_expiry as i64 {
        return Err(GatewayError::AuthorizationExpired.into());
    }

    let proof_start = PAY_AUTHORIZED_HEADER_LEN;
    let proof_end = proof_start + PROOF_LEN;
    let witness_data = &data[proof_end..proof_end + WITNESS_LEN];

    let stored_smt_root = &state_data[40..72];
    let witness_smt_root = &witness_data[12..44];
    if witness_smt_root != stored_smt_root {
        return Err(GatewayError::SmtRootMismatch.into());
    }

    let mut verifier_data = Vec::with_capacity(PROOF_LEN + WITNESS_LEN);
    verifier_data.extend_from_slice(&data[proof_start..proof_end]);
    verifier_data.extend_from_slice(witness_data);

    let verify_ix = Instruction {
        program_id: configured_verifier,
        accounts: vec![],
        data: verifier_data,
    };
    invoke(&verify_ix, &[])?;

    msg!(
        "x402 PayAuthorized verified, auth_id_prefix={:?}",
        &data[0..4]
    );

    invoke(
        &system_instruction::transfer(payer.key, recipient.key, amount),
        &[payer.clone(), recipient.clone(), system_program.clone()],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::system_program;

    fn new_account(
        key: Pubkey,
        owner: Pubkey,
        is_signer: bool,
        is_writable: bool,
        data_len: usize,
    ) -> AccountInfo<'static> {
        let key_ref = Box::leak(Box::new(key));
        let owner_ref = Box::leak(Box::new(owner));
        let lamports_ref = Box::leak(Box::new(0u64));
        let data_ref = Box::leak(vec![0u8; data_len].into_boxed_slice());
        AccountInfo::new(
            key_ref,
            is_signer,
            is_writable,
            lamports_ref,
            data_ref,
            owner_ref,
            false,
            0,
        )
    }

    fn empty_pay_authorized_data() -> Vec<u8> {
        vec![0u8; PAY_AUTHORIZED_DATA_LEN]
    }

    #[test]
    fn pay_authorized_size_constants_match() {
        assert_eq!(PAY_AUTHORIZED_HEADER_LEN, 48);
        assert_eq!(
            PAY_AUTHORIZED_DATA_LEN,
            PAY_AUTHORIZED_HEADER_LEN + PROOF_LEN + WITNESS_LEN
        );
        assert_eq!(PAY_AUTHORIZED_DATA_LEN, 512);
    }

    #[test]
    fn initialize_rejects_missing_signer() {
        let program_id = Pubkey::new_unique();
        let admin = new_account(Pubkey::new_unique(), program_id, false, true, 0);
        let state = new_account(Pubkey::new_unique(), program_id, false, true, STATE_SIZE);
        let system = new_account(system_program::id(), system_program::id(), false, false, 0);

        let err = process_initialize(&program_id, &[admin, state, system], &[0u8; 32]).unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    #[test]
    fn initialize_rejects_invalid_pda() {
        let program_id = Pubkey::new_unique();
        let admin = new_account(Pubkey::new_unique(), program_id, true, true, 0);
        let state = new_account(Pubkey::new_unique(), program_id, false, true, STATE_SIZE);
        let system = new_account(system_program::id(), system_program::id(), false, false, 0);

        let err = process_initialize(&program_id, &[admin, state, system], &[0u8; 32]).unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(GatewayError::InvalidStatePda as u32)
        );
    }

    #[test]
    fn initialize_rejects_invalid_data_length() {
        let program_id = Pubkey::new_unique();
        let admin = new_account(Pubkey::new_unique(), program_id, true, true, 0);
        let state = new_account(Pubkey::new_unique(), program_id, false, true, STATE_SIZE);
        let system = new_account(system_program::id(), system_program::id(), false, false, 0);

        let err = process_initialize(&program_id, &[admin, state, system], &[0u8; 31]).unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(GatewayError::InvalidDataLength as u32)
        );
    }

    #[test]
    fn set_root_rejects_invalid_length() {
        let program_id = Pubkey::new_unique();
        let err = process_set_smt_root(&program_id, &[], &[1u8; 31]).unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(GatewayError::InvalidDataLength as u32)
        );
    }

    #[test]
    fn set_root_rejects_missing_signer() {
        let program_id = Pubkey::new_unique();
        let admin_key = Pubkey::new_unique();
        let admin = new_account(admin_key, program_id, false, true, 0);
        let (state_pda, _bump) =
            Pubkey::find_program_address(&[b"state", admin_key.as_ref()], &program_id);
        let state = new_account(state_pda, program_id, false, true, STATE_SIZE);

        let err = process_set_smt_root(&program_id, &[admin, state], &[0u8; 32]).unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    #[test]
    fn set_root_rejects_invalid_pda() {
        let program_id = Pubkey::new_unique();
        let admin_key = Pubkey::new_unique();
        let admin = new_account(admin_key, program_id, true, true, 0);
        let state = new_account(Pubkey::new_unique(), program_id, false, true, STATE_SIZE);

        let err = process_set_smt_root(&program_id, &[admin, state], &[0u8; 32]).unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(GatewayError::InvalidStatePda as u32)
        );
    }

    #[test]
    fn pay_authorized_rejects_invalid_data_length() {
        let program_id = Pubkey::new_unique();
        let err = process_pay_authorized(&program_id, &[], &[0u8; 10]).unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(GatewayError::InvalidDataLength as u32)
        );
    }

    #[test]
    fn pay_authorized_rejects_missing_signer() {
        let program_id = Pubkey::new_unique();
        let payer = new_account(Pubkey::new_unique(), program_id, false, true, 0);
        let recipient = new_account(Pubkey::new_unique(), program_id, false, true, 0);
        let state = new_account(Pubkey::new_unique(), program_id, false, false, STATE_SIZE);
        let verifier = new_account(Pubkey::new_unique(), program_id, false, false, 0);
        let system = new_account(system_program::id(), system_program::id(), false, false, 0);
        let err = process_pay_authorized(
            &program_id,
            &[payer, recipient, state, verifier, system],
            &empty_pay_authorized_data(),
        )
        .unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    #[test]
    fn pay_authorized_rejects_invalid_verifier_program() {
        let program_id = Pubkey::new_unique();
        let payer = new_account(Pubkey::new_unique(), program_id, true, true, 0);
        let recipient = new_account(Pubkey::new_unique(), program_id, false, true, 0);
        let state = new_account(Pubkey::new_unique(), program_id, false, false, STATE_SIZE);
        let verifier = new_account(Pubkey::new_unique(), program_id, false, false, 0);
        let system = new_account(system_program::id(), system_program::id(), false, false, 0);
        let err = process_pay_authorized(
            &program_id,
            &[payer, recipient, state, verifier, system],
            &empty_pay_authorized_data(),
        )
        .unwrap_err();
        assert_eq!(
            err,
            ProgramError::Custom(GatewayError::InvalidZkVerifier as u32)
        );
    }
}
