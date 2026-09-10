#!/bin/sh
name=geth-$$
trap "echo killing docker; docker kill $name 2> /dev/null" EXIT
port=$1
shift
dir=$(cd "$(dirname "$0")" && pwd)
params="--http --http.api eth,net,web3,debug --rpc.allow-unprotected-txs --dev --http.addr 0.0.0.0"
# geth --dev uses the first keystore account, so importing a well-known test key (hardhat account 0)
# keeps the funded dev account the same across geth versions. the genesis funds it, and preallocates
# a stub for the reserve balance precompile: without the stub geth returns empty data for that
# address, which the EntryPoint reads as "dipped into reserve" and rejects bundle admission.
# Pin Geth 48a7c172 across architectures to match the genesis system contracts.
docker run --name $name --rm -p $port:8545 \
  -v "$dir/geth-genesis.json:/genesis.json:ro" \
  --entrypoint sh ethpandaops/geth@sha256:43011ab57afa3a8f154825b51beaa6687bbffa7005e267f53e808e28434b2d5d -c "
    echo ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 > /key.txt
    : > /pw.txt
    geth --lightkdf --datadir /d account import --password /pw.txt /key.txt > /dev/null 2>&1 &&
    geth --datadir /d init /genesis.json &&
    exec geth --lightkdf --datadir /d $params"
