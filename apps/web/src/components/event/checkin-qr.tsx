"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { activeCheckinChallenge } from "./checkin-qr-state";
import styles from "./checkin-pass.module.css";

/** Adapted from CommitPass EventPass; the QR contains only the expiring server challenge. */
export function CheckinQr({challenge,binding}:{challenge:{token:string;expiresAt:string;binding:string}|null;binding:string}) {
 const [image,setImage]=useState<{token:string;binding:string;url:string}|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{let active=true;setImage(null);setFailed(false);if(!activeCheckinChallenge(challenge,binding))return;void QRCode.toDataURL(challenge!.token,{width:512,margin:4,errorCorrectionLevel:"M",color:{dark:"#252622",light:"#ffffff"}}).then(url=>{if(active&&activeCheckinChallenge(challenge,binding))setImage({token:challenge!.token,binding,url});}).catch(()=>{if(active)setFailed(true);});return()=>{active=false;};},[challenge,binding]);
 if(!activeCheckinChallenge(challenge,binding))return null;
 return <div className={styles.qr}>{image&&image.token===challenge!.token&&image.binding===binding?<img src={image.url} alt="Short-lived check-in QR code" width={180} height={180}/>:<span>{failed?"QR unavailable. Share the token below instead.":"Preparing your check-in QR..."}</span>}</div>;
}
