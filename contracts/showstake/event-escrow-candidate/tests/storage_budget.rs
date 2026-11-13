use near_sdk::{env, testing_env, AccountId, NearToken};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use showstake_event_escrow_candidate::{EventEscrowContract, EventRules};

fn id(value: &str) -> AccountId { value.parse().unwrap() }

#[test]
fn bounded_metadata_and_registration_storage_for_pinned_leaf() {
    for mainnet in [false, true] {
        let host = id(&"a".repeat(64));
        let escrow = id(if mainnet { "escrow.near" } else { "escrow.testnet" });
        let ft = id(if mainnet { "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" } else { "usdc.testnet" });
        let provider = id(if mainnet { "contract.main.burrow.near" } else { "provider.testnet" });
        testing_env!(VMContextBuilder::new().current_account_id(escrow.clone())
            .predecessor_account_id(host.clone()).account_balance(NearToken::from_near(100)).build());
        near_sdk::mock::with_mocked_blockchain(|b| { b.take_storage(); });
        let mut contract = EventEscrowContract::new(host, provider, ft.clone(),
            "USDC".into(), "USDC".into(), 6,
            if mainnet { "RHEA_MAINNET" } else { "MOCK_TESTNET" }.into());
        if mainnet { contract.configure_rhea_cap(U128(400_000_000)); contract.set_rhea_paused(false); }
        let rules = EventRules { event_id:"e".repeat(128), title:"t".repeat(256),
            location:"l".repeat(512), rules_text:"r".repeat(8192), deposit:U128(2_000_000),
            capacity:200, reg_open:0, reg_close:10, checkin_open:10, checkin_close:20,
            finalize_deadline:86_400_020 };
        let metadata_bytes = rules.event_id.len()+rules.title.len()+rules.location.len()+rules.rules_text.len();
        let before = near_sdk::borsh::to_vec(&contract).unwrap().len();
        contract.create_event(rules.clone());
        let event_growth = near_sdk::borsh::to_vec(&contract).unwrap().len()-before;
        assert_eq!(event_growth, metadata_bytes+179+contract.get_config().organizer.as_str().len());
        let mut max_entry = 0;
        for n in 0..200 {
            let sender = id(&format!("{:064x}", n+1));
            let storage = env::storage_usage();
            testing_env!(VMContextBuilder::new().current_account_id(escrow.clone())
                .predecessor_account_id(ft.clone()).signer_account_id(sender.clone())
                .block_timestamp(1_000_000).storage_usage(storage)
                .account_balance(NearToken::from_near(100)).build());
            let prefix = format!("commit-{n}-");
            let commitment = format!("{prefix}{}", "c".repeat(128-prefix.len()));
            let message = near_sdk::serde_json::json!({"version":1,"event_id":rules.event_id,"commitment_id":commitment}).to_string();
            assert!(matches!(contract.ft_on_transfer(sender,U128(2_000_000),message),
                near_sdk::PromiseOrValue::Value(U128(0))));
            let growth = env::storage_usage()-storage;
            max_entry = max_entry.max(growth);
            assert!(growth <= 2304, "registration {n} consumed {growth} bytes");
        }
        println!("mainnet={mainnet}, event_growth={event_growth}, max_registration_bytes={max_entry}");
    }
}
